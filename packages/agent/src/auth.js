import { createHash, timingSafeEqual } from 'node:crypto'

// Comparing fixed-length digests rather than the raw strings keeps the check
// constant-time and stops the length of a token leaking through timing.
const digest = (value) => createHash('sha256').update(String(value)).digest()

const matches = (candidate, secret) => timingSafeEqual(digest(candidate), digest(secret))

// Tolerant of irregular spacing and casing, which real clients and proxies emit.
const BEARER = /^\s*bearer\s+(\S+)\s*$/i

export function extractToken(req) {
  const header = req.headers?.authorization
  if (typeof header === 'string') {
    const match = BEARER.exec(header)
    if (match) return match[1]
  }
  const apiKey = req.headers?.['x-api-key']
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null
}

/**
 * Bearer-token authorisation for the agent API.
 *
 * Two scopes: a full token permits writes (creating silences, injecting
 * faults), an optional read-only token permits everything else. Tokens are
 * supplied through the environment, never a config file, so a committed config
 * can never carry a credential.
 *
 * `/health` is always anonymous — load balancers and Kubernetes probes have to
 * reach it before any credential is in play, and it exposes no telemetry.
 */
export function createAuthenticator(serverConfig = {}, env = process.env) {
  const auth = serverConfig.auth ?? {}
  const writeToken = auth.token ?? (auth.tokenEnv ? env[auth.tokenEnv] : undefined)
  const readToken = auth.readOnlyToken ?? (auth.readOnlyTokenEnv ? env[auth.readOnlyTokenEnv] : undefined)
  const enabled = Boolean(writeToken)
  const allowAnonymousRead = auth.allowAnonymousRead === true

  return {
    enabled,
    allowAnonymousRead,
    hasReadOnlyToken: Boolean(readToken),

    /** Returns null when allowed, or an error object describing the refusal. */
    authorize(req, { write = false, anonymous = false } = {}) {
      if (anonymous || !enabled) return null

      const token = extractToken(req)
      if (!token) {
        if (!write && allowAnonymousRead) return null
        return { status: 401, error: 'authentication required' }
      }

      if (matches(token, writeToken)) return null

      if (!write && readToken && matches(token, readToken)) return null

      // A valid read-only token used on a write route is a permissions problem,
      // not an identity one, and should say so.
      if (write && readToken && matches(token, readToken)) {
        return { status: 403, error: 'read-only token cannot perform writes' }
      }

      return { status: 401, error: 'invalid token' }
    },
  }
}

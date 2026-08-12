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
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

/** Only a loopback bind keeps the API reachable from the local machine alone. */
export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(String(host ?? '').trim().toLowerCase())

export function createAuthenticator(serverConfig = {}, env = process.env) {
  const auth = serverConfig.auth ?? {}
  const writeToken = auth.token ?? (auth.tokenEnv ? env[auth.tokenEnv] : undefined)
  const readToken = auth.readOnlyToken ?? (auth.readOnlyTokenEnv ? env[auth.readOnlyTokenEnv] : undefined)
  const enabled = Boolean(writeToken)
  const allowAnonymousRead = auth.allowAnonymousRead === true
  const loopbackOnly = isLoopbackHost(serverConfig.host)

  return {
    enabled,
    allowAnonymousRead,
    loopbackOnly,
    hasReadOnlyToken: Boolean(readToken),

    /** Returns null when allowed, or an error object describing the refusal. */
    authorize(req, { write = false, anonymous = false } = {}) {
      if (anonymous) return null

      if (!enabled) {
        // Startup refuses this combination outright, so reaching here means
        // something bypassed that check. Defence in depth: never serve a
        // state-changing route unauthenticated off a non-loopback bind.
        if (write && !loopbackOnly) {
          return { status: 401, error: 'authentication required for write routes on a non-loopback bind' }
        }
        return null
      }

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

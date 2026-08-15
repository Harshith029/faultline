import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { createAuthenticator } from './auth.js'

let corsOrigin = '*'

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

const text = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Access-Control-Allow-Origin': corsOrigin,
  })
  res.end(body)
}

// Routes that change state; everything else is a read.
const WRITE_ROUTES = [
  (method, path) => method === 'POST' && path === '/api/silences',
  (method, path) => method === 'DELETE' && path.startsWith('/api/silences/'),
  (method, path) => method === 'POST' && path === '/api/inject',
]

const isWrite = (method, path) => WRITE_ROUTES.some((test) => test(method, path))

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

const readJson = (req, { limitBytes = 64 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('body must be valid JSON'))
      }
    })
    req.on('error', reject)
  })

export function renderPrometheusMetrics(agent) {
  const snapshot = agent.snapshot()
  const lines = [
    '# HELP faultline_up Whether the FAULTLINE agent is running.',
    '# TYPE faultline_up gauge',
    'faultline_up 1',
    '# HELP faultline_ticks_total Collection cycles completed.',
    '# TYPE faultline_ticks_total counter',
    `faultline_ticks_total ${snapshot.ticks}`,
    '# HELP faultline_collect_errors_total Failed collection cycles.',
    '# TYPE faultline_collect_errors_total counter',
    `faultline_collect_errors_total ${snapshot.collectErrors}`,
    '# HELP faultline_empty_collections_total Collections that succeeded but returned no samples.',
    '# TYPE faultline_empty_collections_total counter',
    `faultline_empty_collections_total ${snapshot.emptyCollections}`,
    '# HELP faultline_incomplete_samples_total Samples dropped for missing metrics.',
    '# TYPE faultline_incomplete_samples_total counter',
    `faultline_incomplete_samples_total ${snapshot.dataQuality.incompleteSamples}`,
    '# HELP faultline_telemetry_healthy Whether the agent is observing valid telemetry (distinct from faultline_up).',
    '# TYPE faultline_telemetry_healthy gauge',
    `faultline_telemetry_healthy ${snapshot.health.status === 'ok' ? 1 : 0}`,
    '# HELP faultline_seconds_since_data Seconds since the last complete sample was accepted.',
    '# TYPE faultline_seconds_since_data gauge',
    `faultline_seconds_since_data ${snapshot.health.secondsSinceData ?? -1}`,
    '# HELP faultline_risk_score Current cascade risk score per service.',
    '# TYPE faultline_risk_score gauge',
    '# HELP faultline_qualified_signals Currently qualified drift signals per service.',
    '# TYPE faultline_qualified_signals gauge',
    '# HELP faultline_service_firing Whether a service currently has an open incident.',
    '# TYPE faultline_service_firing gauge',
  ]

  lines.push('# HELP faultline_service_silenced Whether alerting is suppressed for a service.')
  lines.push('# TYPE faultline_service_silenced gauge')
  lines.push('# HELP faultline_service_stale_seconds Seconds since a complete sample for this service.')
  lines.push('# TYPE faultline_service_stale_seconds gauge')

  const staleness = new Map(
    snapshot.dataQuality.freshness.map((f) => [f.service, f.staleSeconds])
  )

  for (const service of snapshot.services) {
    const label = `{service="${escapeLabel(service.service)}"}`
    if (service.status === 'evaluated') {
      lines.push(`faultline_risk_score${label} ${service.R_score}`)
      lines.push(`faultline_qualified_signals${label} ${service.signal_count}`)
    }
    lines.push(`faultline_service_firing${label} ${service.firing ? 1 : 0}`)
    lines.push(`faultline_service_silenced${label} ${service.silencedBy ? 1 : 0}`)
    const stale = staleness.get(service.service)
    if (Number.isFinite(stale)) lines.push(`faultline_service_stale_seconds${label} ${stale}`)
  }

  lines.push('# HELP faultline_silences_active Currently active silences.')
  lines.push('# TYPE faultline_silences_active gauge')
  lines.push(`faultline_silences_active ${snapshot.silences}`)

  lines.push('# HELP faultline_incidents_total Incidents recorded since first run.')
  lines.push('# TYPE faultline_incidents_total gauge')
  lines.push(`faultline_incidents_total ${snapshot.incidents.total}`)
  lines.push(`faultline_incidents_open ${snapshot.incidents.firing}`)

  return lines.join('\n') + '\n'
}

export function createApiServer(agent, { logger, serverConfig = {}, env = process.env } = {}) {
  const auth = createAuthenticator(serverConfig, env)
  corsOrigin = serverConfig.corsOrigin ?? '*'

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const route = `${req.method} ${url.pathname}`

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
        })
        return res.end()
      }

      const refusal = auth.authorize(req, {
        write: isWrite(req.method, url.pathname),
        anonymous: url.pathname === '/health',
      })
      if (refusal) {
        logger.warn('server.unauthorized', { route, status: refusal.status })
        if (refusal.status === 401) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="faultline"')
        }
        return json(res, refusal.status, { error: refusal.error })
      }

      if (route === 'GET /health') {
        const snapshot = agent.snapshot()
        const health = snapshot.health
        const healthy = health.status === 'ok'
        return json(res, healthy ? 200 : 503, {
          status: health.status,
          // "The process is up" and "the telemetry is trustworthy" are separate
          // claims. A probe that only ever saw the first is how a silent
          // exporter failure gets mistaken for a quiet night.
          reasons: health.reasons,
          agent: snapshot.name,
          version: snapshot.version,
          uptimeSeconds: snapshot.uptimeSeconds,
          source: snapshot.source,
          intervalSeconds: snapshot.intervalSeconds,
          ticks: snapshot.ticks,
          lastCollectAt: snapshot.lastCollectAt,
          consecutiveCollectErrors: snapshot.consecutiveCollectErrors,
          consecutiveEmptyCollections: snapshot.consecutiveEmptyCollections,
          lastDataAt: health.lastDataAt,
          secondsSinceData: health.secondsSinceData,
          noDataGraceSeconds: health.noDataGraceSeconds,
          staleServices: health.staleServices,
          incompleteSamples: snapshot.dataQuality.incompleteSamples,
          servicesTracked: snapshot.services.length,
        })
      }

      if (route === 'GET /api/state') {
        return json(res, 200, agent.snapshot())
      }

      if (route === 'GET /api/ranking') {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return json(res, 200, agent.ranking({ limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50 }))
      }

      if (route === 'GET /api/incidents') {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return json(res, 200, {
          incidents: agent.store.getIncidents({
            limit: Number.isFinite(limit) ? Math.min(limit, 500) : 50,
            status: url.searchParams.get('status') ?? undefined,
            service: url.searchParams.get('service') ?? undefined,
          }),
        })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/incidents/')) {
        const incident = agent.store.getIncident(url.pathname.split('/').pop())
        if (!incident) return json(res, 404, { error: 'incident not found' })
        return json(res, 200, incident)
      }

      if (route === 'GET /api/windows') {
        const service = url.searchParams.get('service')
        if (!service) return json(res, 400, { error: 'query parameter "service" is required' })
        const windows = agent.detector.windowsFor(service)
        if (windows.length === 0) return json(res, 404, { error: `no windows for service "${service}"` })
        const detection = agent.detector.detectionFor(service)
        return json(res, 200, {
          service,
          windows,
          baselines: detection?.baselines ?? null,
          params: detection?.params ?? null,
        })
      }

      if (route === 'GET /api/silences') {
        return json(res, 200, {
          silences: agent.silences.list({ activeOnly: url.searchParams.get('active') === 'true' }),
        })
      }

      if (route === 'POST /api/silences') {
        let body
        try {
          body = await readJson(req)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
        try {
          const silence = agent.silences.add(body)
          agent.syncSilences()
          return json(res, 201, silence)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/silences/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop())
        if (id.startsWith('cfg:')) {
          return json(res, 400, { error: 'config-defined silences cannot be removed at runtime' })
        }
        if (!agent.silences.remove(id)) return json(res, 404, { error: 'silence not found' })
        agent.syncSilences()
        return json(res, 200, { removed: id })
      }

      if (route === 'GET /metrics') {
        return text(res, 200, renderPrometheusMetrics(agent))
      }

      if (route === 'POST /api/inject') {
        if (typeof agent.source.inject !== 'function') {
          return json(res, 400, { error: `source "${agent.source.name}" does not support fault injection` })
        }
        const service = url.searchParams.get('service') ?? undefined
        return json(res, 202, agent.source.inject(service))
      }

      return json(res, 404, { error: 'not found', route })
    } catch (err) {
      logger.error('server.request_failed', { route, message: err.message })
      return json(res, 500, { error: 'internal error' })
    }
  }

  const tls = serverConfig.tls
  if (tls?.certFile && tls?.keyFile) {
    let cert
    let key
    try {
      cert = readFileSync(tls.certFile)
      key = readFileSync(tls.keyFile)
    } catch (err) {
      // Failing to start is the correct behaviour: silently downgrading to
      // plaintext because a certificate is unreadable is how secrets leak.
      throw new Error(`TLS is configured but the certificate could not be read: ${err.message}`)
    }
    const server = createTlsServer({ cert, key, ...(tls.caFile ? { ca: readFileSync(tls.caFile) } : {}) }, handler)
    server.faultlineTls = true
    server.faultlineAuth = auth
    return server
  }

  const server = createServer(handler)
  server.faultlineTls = false
  server.faultlineAuth = auth
  return server
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent, DELIVERY_CONCURRENCY } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

// Operating the agent under an orchestrator: liveness that cannot restart-loop
// on a telemetry outage, retiring services that are gone, and notification
// delivery that neither serialises a burst of incidents nor holds up detection.

const TOKEN = 'ops-full-token'
const READ = 'ops-read-token'

const sample = (service, over = {}) => ({ service, p99_latency: 120, retry_rate: 1, error_rate: 0.4, ...over })
const elevated = (service) => sample(service, { p99_latency: 600, retry_rate: 9, error_rate: 6 })

const WITH_AUTH = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  auth: { tokenEnv: 'FL_OPS_TOKEN', readOnlyTokenEnv: 'FL_OPS_READ' },
}

/** An agent whose source is a function the test controls. */
const agentWith = async (collect, { detector = {}, server = null, dir = null, alerting = {} } = {}) => {
  const storageDir = dir ?? (await mkdtemp(join(tmpdir(), 'faultline-ops-')))
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: {
        intervalSeconds: 3600,
        baselineWindows: 4,
        minSustain: 2,
        historyWindows: 20,
        noDataGraceSeconds: 60,
        ...detector,
      },
      alerting: { cooldownSeconds: 0, resolveAfterWindows: 2, notifiers: [], ...alerting },
      server: server ?? { enabled: false },
      storage: { path: join(storageDir, 'state.json') },
    },
  })
  const agent = new FaultlineAgent(config, { logger: silentLogger, env: { FL_OPS_TOKEN: TOKEN, FL_OPS_READ: READ } })
  agent.source = { name: 'stub', collect, state: () => ({}) }
  return agent
}

const baseOf = (agent) => `http://127.0.0.1:${agent.server.address().port}`
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

// fetch() will not let a caller set Host, and a kubelet probes with the pod IP.
const getWithHost = (port, path, host) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })

// --- liveness ---------------------------------------------------------------

test('/livez stays up while telemetry is stale, so a liveness probe cannot restart-loop on an exporter outage', async () => {
  const agent = await agentWith(async () => [], { detector: { noDataGraceSeconds: 0 }, server: WITH_AUTH })
  await agent.start()
  try {
    // Nothing has ever arrived, and the grace period is long gone.
    agent.startedAtMs -= 10_000

    assert.equal((await fetch(`${baseOf(agent)}/health`)).status, 503)

    const live = await fetch(`${baseOf(agent)}/livez`)
    assert.equal(live.status, 200, 'restarting the agent cannot fix a missing exporter')
    const body = await live.json()
    assert.equal(body.status, 'ok')
    assert.deepEqual(body.reasons, [])
  } finally {
    await agent.stop()
  }
})

test('/livez fails once a collection has been stuck longer than the stall limit', async () => {
  let release
  const agent = await agentWith(
    () =>
      new Promise((resolve) => {
        release = () => resolve([])
      })
  )
  agent.running = true
  const inFlight = agent.tick()

  const startedAt = agent.tickStartedAtMs
  const { stallSeconds } = agent.liveness(startedAt)
  assert.equal(agent.liveness(startedAt + stallSeconds * 1000).status, 'ok', 'slow is not stuck')

  const stuck = agent.liveness(startedAt + (stallSeconds + 1) * 1000)
  assert.equal(stuck.status, 'failing')
  assert.deepEqual(stuck.reasons, ['collection_stalled'])

  release()
  await inFlight
  assert.equal(agent.liveness().status, 'ok')
  assert.ok(agent.liveness().lastTickCompletedAt)
})

test('probes answer whatever Host header they arrive with; other routes on a token-less agent still refuse it', async () => {
  const agent = await agentWith(async () => [sample('api')], { server: { enabled: true, host: '127.0.0.1', port: 0 } })
  await agent.start()
  try {
    const port = agent.server.address().port
    assert.equal(await getWithHost(port, '/livez', '10.1.2.3:8787'), 200)
    assert.equal(await getWithHost(port, '/api/state', '10.1.2.3:8787'), 421)
  } finally {
    await agent.stop()
  }
})

// --- retiring services ------------------------------------------------------

test('retiring a vanished service clears it from health, ranking and metrics', async () => {
  let reporting = ['api', 'worker']
  const agent = await agentWith(async () => reporting.map((s) => sample(s)), { server: WITH_AUTH })
  await agent.start()
  try {
    // worker is decommissioned. Age it past the grace period.
    reporting = ['api']
    agent.detector.lastCompleteSampleAt.set('worker', Date.now() - 120_000)
    assert.ok(agent.health().reasons.includes('service_telemetry_stale'))

    const res = await fetch(`${baseOf(agent)}/api/services/worker`, { method: 'DELETE', headers: bearer(TOKEN) })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { retired: 'worker', incidentClosed: null })

    assert.equal(agent.health().status, 'ok')
    const ranking = await (await fetch(`${baseOf(agent)}/api/ranking`, { headers: bearer(READ) })).json()
    assert.deepEqual(
      ranking.services.map((s) => s.service),
      ['api']
    )
    const metrics = await (await fetch(`${baseOf(agent)}/metrics`, { headers: bearer(READ) })).text()
    assert.doesNotMatch(metrics, /service="worker"/)
    assert.match(metrics, /^faultline_services_retired_total\{reason="operator"\} 1$/m)
    assert.match(metrics, /^faultline_services_retired_total\{reason="silent"\} 0$/m)

    const again = await fetch(`${baseOf(agent)}/api/services/worker`, { method: 'DELETE', headers: bearer(TOKEN) })
    assert.equal(again.status, 404)
  } finally {
    await agent.stop()
  }
})

test('retiring a service is a write: it needs the full token and a trusted origin', async () => {
  const agent = await agentWith(async () => [sample('api')], { server: WITH_AUTH })
  await agent.start()
  try {
    const url = `${baseOf(agent)}/api/services/api`
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 401)
    assert.equal((await fetch(url, { method: 'DELETE', headers: bearer(READ) })).status, 403)
    const crossSite = await fetch(url, {
      method: 'DELETE',
      headers: { ...bearer(TOKEN), Origin: 'https://evil.example' },
    })
    assert.equal(crossSite.status, 403)
    assert.ok(agent.detector.services().includes('api'), 'nothing was retired')
  } finally {
    await agent.stop()
  }
})

test('retiring a firing service closes its incident as retired and notifies nobody', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-ops-'))
  const alertsPath = join(dir, 'alerts.jsonl')
  let hot = false
  const agent = await agentWith(async () => [hot ? elevated('api') : sample('api')], {
    dir,
    alerting: { notifiers: [{ type: 'file', path: alertsPath }] },
  })

  await agent.start()
  for (let i = 0; i < 3; i++) await agent.tick()
  hot = true
  await agent.tick()
  await agent.tick()
  assert.equal(agent.alerts.isFiring('api'), true)

  const outcome = await agent.retireService('api')
  const incident = agent.store.getIncident(outcome.incidentClosed)
  assert.equal(incident.status, 'retired')
  assert.equal(incident.endReason, 'service_retired')
  assert.ok(incident.endedAt)
  assert.equal(agent.alerts.isFiring('api'), false)

  const events = (await readFile(alertsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).type)
  assert.deepEqual(events, ['incident.opened'], 'no resolve is sent for a recovery nobody observed')

  await agent.stop()
})

test('automatic retirement removes silent services but never one with an open incident', async () => {
  const agent = await agentWith(async () => [sample('api'), sample('worker')], {
    detector: { noDataGraceSeconds: 60, retireAfterSeconds: 120 },
  })
  await agent.start()

  agent.alerts.evaluate({
    service: 'worker',
    evaluation: { triggered: true, R_score: 5, signal_count: 2, qualified_signals: [], metrics: {} },
  })

  const retired = agent.retireSilentServices(Date.now() + 10 * 60_000)
  assert.deepEqual(
    retired.map((r) => r.service),
    ['api']
  )
  assert.deepEqual(agent.detector.services(), ['worker'], 'a firing service that went quiet is left for a human')

  // A silent retirement also removed a stale-telemetry alarm, so it is counted
  // apart from operator ones and listed where an operator will look.
  const snapshot = agent.snapshot()
  assert.deepEqual(snapshot.retiredServices, { operator: 0, silent: 1 })
  assert.equal(snapshot.recentRetirements[0].service, 'api')
  assert.equal(snapshot.recentRetirements[0].reason, 'silent')

  await agent.stop()
})

test('retiring a service during a stuck collection answers 503 instead of hanging', async () => {
  let wedge = false
  let release
  const agent = await agentWith(
    async () =>
      wedge
        ? new Promise((resolve) => {
            release = () => resolve([sample('api')])
          })
        : [sample('api')],
    { server: WITH_AUTH }
  )
  await agent.start()
  try {
    agent.retireWaitMs = 50
    wedge = true
    const stuck = agent.tick()

    const res = await fetch(`${baseOf(agent)}/api/services/api`, { method: 'DELETE', headers: bearer(TOKEN) })
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '5')
    assert.ok(agent.detector.services().includes('api'), 'nothing was retired')

    release()
    await stuck
    const retry = await fetch(`${baseOf(agent)}/api/services/api`, { method: 'DELETE', headers: bearer(TOKEN) })
    assert.equal(retry.status, 200)
  } finally {
    await agent.stop()
  }
})

test('a malformed silence id is a 400, not a server error', async () => {
  const agent = await agentWith(async () => [sample('api')], { server: WITH_AUTH })
  await agent.start()
  try {
    const res = await fetch(`${baseOf(agent)}/api/silences/%E0%A4%A`, { method: 'DELETE', headers: bearer(TOKEN) })
    assert.equal(res.status, 400)
  } finally {
    await agent.stop()
  }
})

test('samples without a source timestamp carry the start of their collection cycle', async () => {
  // However long collection takes, consecutive cycles are then one interval
  // apart; stamping at parse time made a slow scrape look like a hole.
  let collectStartedAt = null
  const agent = await agentWith(async () => {
    collectStartedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 120))
    return [sample('api')]
  })
  await agent.start()

  const stamped = Date.parse(agent.detector.buffer.get('api').at(-1).timestamp)
  assert.ok(stamped <= collectStartedAt, 'stamped after collection had already begun')

  await agent.stop()
})

test('a retired service is not brought back by the next restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-ops-'))
  const first = await agentWith(async () => [sample('api'), sample('worker')], { dir })
  await first.start()
  await first.tick()
  await first.retireService('worker')
  await first.stop()

  const second = await agentWith(async () => [sample('api')], { dir })
  await second.start()
  try {
    assert.equal(second.stateRestore.restored, true)
    assert.deepEqual(second.detector.services(), ['api'])
  } finally {
    await second.stop()
  }
})

// --- notification delivery ---------------------------------------------------

test('a tick sends its notifications a few at a time, not one after another', async () => {
  const agent = await agentWith(async () => [])
  let active = 0
  let peak = 0
  let sent = 0
  agent.maybeNotify = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    sent += 1
  }

  const jobs = Array.from({ length: 10 }, (_, i) => ({
    type: 'incident.opened',
    incident: { id: `inc_${i}`, service: `svc-${i}` },
  }))
  await agent.deliver(jobs)

  assert.equal(sent, 10)
  assert.equal(peak, DELIVERY_CONCURRENCY)
})

test('one delivery that throws does not abandon the others', async () => {
  const agent = await agentWith(async () => [])
  const sent = []
  agent.maybeNotify = async (type, incident) => {
    if (incident.id === 'inc_2') throw new Error('boom')
    sent.push(incident.id)
  }

  // All for one service, so the ones after the failure are queued behind it.
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    type: 'incident.opened',
    incident: { id: `inc_${i}`, service: 'api' },
  }))
  await agent.deliver(jobs)

  assert.deepEqual(sent, ['inc_0', 'inc_1', 'inc_3', 'inc_4'])
})

test('a burst of incidents reaches a slow webhook concurrently, and every one is delivered', async () => {
  let inFlight = 0
  let peak = 0
  const received = []
  const hook = createServer((req, res) => {
    let body = ''
    inFlight += 1
    peak = Math.max(peak, inFlight)
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      setTimeout(() => {
        received.push(JSON.parse(body).incident.service)
        inFlight -= 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      }, 100)
    })
  })
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve))

  const services = ['a', 'b', 'c', 'd', 'e', 'f']
  let hot = false
  const agent = await agentWith(async () => services.map((s) => (hot ? elevated(s) : sample(s))), {
    alerting: { notifiers: [{ type: 'webhook', url: `http://127.0.0.1:${hook.address().port}/hook` }] },
  })
  try {
    await agent.start()
    for (let i = 0; i < 3; i++) await agent.tick()
    hot = true
    await agent.tick()
    await agent.tick()

    assert.deepEqual(received.sort(), services)
    assert.ok(peak > 1, `deliveries were serialised (peak ${peak})`)
    assert.ok(peak <= DELIVERY_CONCURRENCY, `more than ${DELIVERY_CONCURRENCY} deliveries at once (peak ${peak})`)
  } finally {
    await agent.stop()
    await new Promise((resolve) => hook.close(resolve))
  }
})

// A webhook that records each alert as it arrives and answers none of them
// until release(), so a test decides exactly how long a delivery stays in flight.
const gatedWebhook = async () => {
  const held = []
  let released = false
  const hook = { received: [], peakHeld: 0 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { event, incident } = JSON.parse(body)
      hook.received.push({ service: incident.service, event })
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      }
      if (released) return respond()
      held.push(respond)
      hook.peakHeld = Math.max(hook.peakHeld, held.length)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  hook.url = `http://127.0.0.1:${server.address().port}/hook`
  hook.release = () => {
    released = true
    for (const respond of held.splice(0)) respond()
  }
  hook.close = () => new Promise((resolve) => server.close(resolve))
  return hook
}

/** One service whose alert is still unanswered when the tick that sent it returns. */
const agentWithHeldAlert = async (hook) => {
  let hot = false
  const agent = await agentWith(async () => [hot ? elevated('api') : sample('api')], {
    alerting: { notifiers: [{ type: 'webhook', url: hook.url }] },
  })
  agent.deliveryBudgetMs = 20
  await agent.start()
  for (let i = 0; i < 3; i++) await agent.tick()
  hot = true
  await agent.tick()
  await agent.tick()
  assert.ok(agent.alerts.isFiring('api'))
  assert.equal(agent.pendingDeliveries.size, 1, 'the alert outlived the tick that queued it')
  return agent
}

test('a slow webhook cannot hold up the next collection, and every alert still arrives once, in order', async () => {
  const hook = await gatedWebhook()
  // `first` fills every send slot; `second` starts failing one window later.
  const first = Array.from({ length: DELIVERY_CONCURRENCY }, (_, i) => `first-${i}`)
  const second = ['second-0', 'second-1']
  const all = [...first, ...second]
  const hot = new Set()
  const agent = await agentWith(async () => all.map((s) => (hot.has(s) ? elevated(s) : sample(s))), {
    alerting: { notifiers: [{ type: 'webhook', url: hook.url }] },
  })
  agent.deliveryBudgetMs = 50
  try {
    await agent.start()
    for (let i = 0; i < 3; i++) await agent.tick()
    for (const s of first) hot.add(s)
    await agent.tick()
    for (const s of second) hot.add(s)

    // This window opens `first`. The webhook answers none of it, yet the tick
    // returns once its budget is spent rather than waiting on the receiver.
    const startedAt = Date.now()
    await agent.tick()
    const tickMs = Date.now() - startedAt
    assert.equal(agent.store.stats().firing, first.length)
    // Waiting on the webhook would have taken its 5 s timeout.
    assert.ok(tickMs < agent.deliveryBudgetMs + 2000, `the tick waited on the webhook (${tickMs} ms)`)

    // `second` opens while `first` holds every slot, so its alerts wait their
    // turn; `first`, still firing and still unconfirmed, is not sent again.
    await agent.tick()
    assert.equal(agent.store.stats().firing, all.length)

    // Everything recovers while every open is still unanswered. Each resolve is
    // queued behind its own open rather than dropped for lack of a delivery.
    hot.clear()
    for (let i = 0; i < 10 && agent.store.stats().resolved < all.length; i++) await agent.tick()
    assert.equal(agent.store.stats().resolved, all.length)
    assert.deepEqual(
      hook.received.map((r) => r.service).sort(),
      first,
      'only the first alerts have been sent: the rest are queued and nothing was sent twice'
    )

    // The receiver recovers, and stop() waits for the backlog to drain.
    hook.release()
    await agent.stop()

    for (const service of all) {
      assert.deepEqual(
        hook.received.filter((r) => r.service === service).map((r) => r.event),
        ['incident.opened', 'incident.resolved'],
        `${service}: exactly one open, then exactly one resolve`
      )
    }
    assert.equal(hook.peakHeld, DELIVERY_CONCURRENCY, 'the send limit holds across ticks')
    for (const incident of agent.store.getIncidents()) {
      assert.ok(incident.notifiedAt, `${incident.service} is saved as delivered`)
      assert.deepEqual(incident.deliveredTo, ['0:webhook'])
    }
  } finally {
    hook.release()
    await agent.stop()
    await hook.close()
  }
})

test('retiring a service waits for its alert still being sent, so the retirement is not overwritten', async () => {
  const hook = await gatedWebhook()
  const agent = await agentWithHeldAlert(hook)
  try {
    // Retired now, the delivery would settle afterwards and save the incident
    // back as firing over its retired record.
    agent.retireWaitMs = 50
    await assert.rejects(agent.retireService('api'), { code: 'AGENT_BUSY' })
    assert.ok(agent.alerts.isFiring('api'), 'nothing was retired')

    hook.release()
    const { incidentClosed } = await agent.retireService('api', { waitMs: 2000 })
    await agent.stop()
    const record = agent.store.getIncident(incidentClosed)
    assert.equal(record.status, 'retired')
    assert.ok(record.notifiedAt, 'the retired record carries what the delivery recorded')
  } finally {
    hook.release()
    await agent.stop()
    await hook.close()
  }
})

test('stop() waits for an alert still being sent in the background, but only for its grace period', async () => {
  const hook = await gatedWebhook()
  const agent = await agentWithHeldAlert(hook)
  try {
    const graceMs = 300
    const startedAt = Date.now()
    const stopping = agent.stop({ graceMs })
    const early = await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ])
    assert.equal(early, 'waiting', 'stop() did not wait for the alert')

    await stopping
    const stopMs = Date.now() - startedAt
    // Waiting on the alert would have taken the webhook's 5 s timeout.
    assert.ok(stopMs < graceMs + 2000, `stop() overran its grace period (${stopMs} ms)`)
  } finally {
    hook.release()
    await Promise.all(agent.pendingDeliveries.values())
    await agent.stop()
    await hook.close()
  }
})

// --- configuration ------------------------------------------------------------

test('maxSampleGapSeconds must exceed the collection interval', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { intervalSeconds: 60, maxSampleGapSeconds: 60 } } }),
    /maxSampleGapSeconds \(60\) must be greater than detector\.intervalSeconds/
  )
  assert.doesNotThrow(() =>
    loadConfig({ env: {}, overrides: { detector: { intervalSeconds: 60, maxSampleGapSeconds: 90 } } })
  )
})

test('retireAfterSeconds must leave time for a service to be reported stale first', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { noDataGraceSeconds: 300, retireAfterSeconds: 300 } } }),
    /retireAfterSeconds \(300\) must be greater than detector\.noDataGraceSeconds/
  )
  assert.doesNotThrow(() =>
    loadConfig({ env: {}, overrides: { detector: { noDataGraceSeconds: 300, retireAfterSeconds: 3600 } } })
  )
})

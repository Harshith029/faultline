import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const severityFor = (incident) => (incident.peakR >= 6 ? 'critical' : 'warning')

export function formatIncidentText(event) {
  const { incident } = event
  const signals = incident.signals?.map((s) => `${s.metric.replace(/_z$/, '')} z=${s.z_score}`).join(', ')
  if (event.type === 'incident.resolved') {
    const seconds = Math.round((incident.durationMs ?? 0) / 1000)
    const duration = seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`
    return `[FAULTLINE] RESOLVED ${incident.service} — cascade risk cleared after ${incident.windowsFiring} window(s), ${duration}. Peak R=${incident.peakR.toFixed(2)}.`
  }
  return `[FAULTLINE] ${severityFor(incident).toUpperCase()} ${incident.service} — cascade detected. R=${incident.triggerR.toFixed(2)} (threshold crossed) with ${incident.triggerSignalCount} converging signal(s): ${signals || 'n/a'}.`
}

function stdoutNotifier(_config, { logger }) {
  return {
    type: 'stdout',
    async send(event) {
      const line = formatIncidentText(event)
      const fields = {
        incident: event.incident.id,
        service: event.incident.service,
        R: event.incident.lastR,
        signals: event.incident.signals?.length ?? 0,
      }
      if (event.type === 'incident.resolved') logger.info(line, fields)
      else logger.warn(line, fields)
    },
  }
}

function webhookNotifier(config, { logger }) {
  const url = config.url ?? process.env[config.urlEnv]
  if (!url) {
    throw new Error(
      `webhook notifier: no URL. Set "url" or export ${config.urlEnv ?? 'FAULTLINE_WEBHOOK_URL'}.`
    )
  }
  const timeoutMs = config.timeoutMs ?? 5000

  return {
    type: 'webhook',
    async send(event) {
      const { incident } = event
      const body = {
        // `text` makes the payload directly usable by Slack/Mattermost/Discord.
        text: formatIncidentText(event),
        event: event.type,
        severity: event.type === 'incident.resolved' ? 'resolved' : severityFor(incident),
        agent: event.agent,
        incident,
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new Error(`webhook responded ${res.status}`)
      }
      logger.debug('notify.webhook_sent', { incident: incident.id, status: res.status })
    },
  }
}

function fileNotifier(config) {
  const path = resolve(config.path)
  return {
    type: 'file',
    async send(event) {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf8')
    },
  }
}

const BUILDERS = { stdout: stdoutNotifier, webhook: webhookNotifier, file: fileNotifier }

export function createNotifiers(configs = [], ctx) {
  const sinks = configs.map((config) => BUILDERS[config.type](config, ctx))

  return {
    types: sinks.map((s) => s.type),
    async notify(event) {
      const results = await Promise.allSettled(sinks.map((sink) => sink.send(event)))
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          // A failing notifier must never take the agent down or block detection.
          ctx.logger.error('notify.failed', {
            notifier: sinks[i].type,
            incident: event.incident?.id,
            message: result.reason?.message ?? String(result.reason),
          })
        }
      })
      return results
    },
  }
}

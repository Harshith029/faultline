import { useEffect, useState } from 'react'

const SEVERITY_CONFIG = {
  nominal: {
    color: '#38BDF8',
    badgeClass: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    panelClass: 'border-sky-400/15 bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-sky-500/[0.08]',
    label: 'Nominal',
  },
  watching: {
    color: '#38BDF8',
    badgeClass: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    panelClass: 'border-sky-400/15 bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-sky-500/[0.08]',
    label: 'Watching',
  },
  warning: {
    color: '#F59E0B',
    badgeClass: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    panelClass: 'border-amber-400/15 bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-amber-500/[0.08]',
    label: 'Warning',
  },
  triggered: {
    color: '#F43F5E',
    badgeClass: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    panelClass: 'border-rose-400/15 bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-rose-500/[0.08]',
    label: 'Cascade',
  },
  outage: {
    color: '#F43F5E',
    badgeClass: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    panelClass: 'border-rose-400/15 bg-gradient-to-br from-slate-950/90 via-slate-900/70 to-rose-500/[0.08]',
    label: 'Outage',
  },
}

const WINDOW_INSIGHTS = [
  {
    title: 'System Nominal',
    severity: 'nominal',
    insight: 'All services are operating within expected parameters. Baseline latency, retry rate, and error rate remain inside the normal envelope, with no qualified drift signals.',
    trajectoryText: 'Stable baseline',
    prediction: null,
  },
  {
    title: 'System Nominal',
    severity: 'nominal',
    insight: 'Telemetry remains healthy. Latency is drifting slightly upward, but the movement still looks like ordinary variance rather than a structural failure pattern.',
    trajectoryText: 'Stable baseline',
    prediction: null,
  },
  {
    title: 'Early Elevation Detected',
    severity: 'watching',
    insight: 'P99 latency is trending upward across multiple windows. The behavior is not yet qualified, but the direction is consistent enough to keep under watch.',
    trajectoryText: 'Directional drift forming',
    prediction: 'If the trend persists, latency will cross the qualification threshold within one or two windows.',
  },
  {
    title: 'Threshold Approach',
    severity: 'watching',
    insight: 'Latency has crossed the threshold for the first time. It is still a single-window event, so the system remains in watch mode while persistence is evaluated.',
    trajectoryText: 'Threshold crossed',
    prediction: 'A second elevated window will qualify latency as the first active signal.',
  },
  {
    title: 'Signal 1 Qualified',
    severity: 'warning',
    insight: 'Latency has now sustained above threshold long enough to qualify. This marks the first concrete sign of structural instability rather than transient variance.',
    trajectoryText: 'One signal active',
    prediction: 'Retry amplification is the next likely signal to join if the service remains under stress.',
  },
  {
    title: 'Amplification Pattern Forming',
    severity: 'warning',
    insight: 'Latency continues strengthening while retry behavior approaches threshold. This pattern is significant because retries can compound upstream pressure and accelerate a cascade.',
    trajectoryText: 'Amplification loop forming',
    prediction: 'A retry qualification next window would push the system closer to the trigger band.',
  },
  {
    title: 'Two Signals Converging',
    severity: 'warning',
    insight: 'Retry behavior is now qualified alongside latency. With two converging signals active, the system is entering a high-risk pre-trigger state.',
    trajectoryText: 'Critical approach',
    prediction: 'If error rate qualifies next, the cascade threshold will be crossed.',
  },
  {
    title: 'Incident Detected',
    severity: 'triggered',
    insight: 'FAULTLINE has triggered. All three signals have converged, pushing the R score above the 3.0 threshold before the outage window and surfacing a likely root mechanism in service-b.',
    trajectoryText: 'Detection active',
    prediction: 'Without intervention, downstream dependencies will continue entering the blast radius.',
  },
  {
    title: 'Cascade Propagating',
    severity: 'triggered',
    insight: 'The cascade is deepening. Downstream services are now validating the initial hypothesis as degraded upstream behavior spreads across the path.',
    trajectoryText: 'Blast radius widening',
    prediction: 'User-facing impact becomes increasingly likely over the next few windows.',
  },
  {
    title: 'Severe Degradation',
    severity: 'triggered',
    insight: 'All monitored metrics indicate severe degradation. Recovery is still possible, but the focus is shifting from prevention toward limiting impact and shortening duration.',
    trajectoryText: 'Recovery path narrowing',
    prediction: 'Requests traveling through the identified path are now likely to experience visible failure.',
  },
  {
    title: 'Critical Pre-Outage',
    severity: 'triggered',
    insight: 'The system is in extreme territory. Intervention now primarily reduces outage duration rather than avoiding the incident completely.',
    trajectoryText: 'Final pre-outage window',
    prediction: 'Outage confirmation is expected in the next window if no control is applied.',
  },
  {
    title: 'Cascade Failure Confirmed',
    severity: 'outage',
    insight: 'The modeled cascade has become a confirmed outage. Earlier lead time represented the difference between prevention and active recovery.',
    trajectoryText: 'Recovery mode',
    prediction: null,
  },
]

const METRIC_LABELS = {
  p99_latency_z: 'Latency',
  retry_rate_z: 'Retry',
  error_rate_z: 'Errors',
}

const getOperatorTakeaway = (severity) => {
  if (severity === 'outage') {
    return 'Contain impact first, then coordinate service-b recovery and downstream stabilization.'
  }

  if (severity === 'triggered') {
    return 'Prioritize service-b, reduce retry amplification, and slow blast-radius expansion before the outage window worsens.'
  }

  if (severity === 'warning') {
    return 'Prepare mitigations now. The system has moved from drift into structural instability and is one joining signal away from escalation.'
  }

  if (severity === 'watching') {
    return 'Stay focused on persistence. One elevated window matters less than whether the same signal sustains again.'
  }

  return 'Maintain baseline watch while validating that the current movement stays inside ordinary variance.'
}

export default function AIInsightPanel({ activeWindow, activeWindowData }) {
  const [displayedText, setDisplayedText] = useState('')
  const [isTyping, setIsTyping] = useState(false)

  useEffect(() => {
    const insight = WINDOW_INSIGHTS[activeWindow - 1]
    if (!insight) return

    setDisplayedText('')
    setIsTyping(true)

    const fullText = insight.insight
    let index = 0

    const timer = setInterval(() => {
      if (index < fullText.length) {
        setDisplayedText(fullText.slice(0, index + 1))
        index += 1
      } else {
        setIsTyping(false)
        clearInterval(timer)
      }
    }, 12)

    return () => clearInterval(timer)
  }, [activeWindow])

  const insight = WINDOW_INSIGHTS[activeWindow - 1]
  if (!insight) return null

  const config = SEVERITY_CONFIG[insight.severity]
  const signalCount = activeWindowData?.qualified_signals?.length ?? 0
  const confidence = Math.round((activeWindowData?.confidence ?? 0) * 100)
  const riskScore = activeWindowData?.R_score ?? 0
  const distanceToTrigger = Math.max(0, 3 - riskScore)
  const signals = activeWindowData?.qualified_signals ?? []
  const operatorTakeaway = getOperatorTakeaway(insight.severity)

  return (
    <div
      className={`insight-panel rounded-[28px] border p-5 ${config.panelClass}`}
      style={{ '--insight-glow': `${config.color}33` }}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            AI Analysis
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            {insight.title}
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Operator-facing interpretation of the active window using deterministic detection output and the current signal mix.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className={`rounded-full border px-3 py-1.5 text-xs font-medium ${config.badgeClass}`}>
            {config.label}
          </div>
          <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
            W{activeWindow} / 12
          </div>
          <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
            R {riskScore.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="space-y-4">
          <div className="terminal-panel rounded-[24px] border border-white/8 p-5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: config.color,
                  boxShadow: `0 0 14px ${config.color}66`,
                }}
              />
              Live model brief
            </div>
            <div className="mt-4 min-h-[148px] text-[15px] leading-8 text-slate-200">
              {displayedText}
              {isTyping && (
                <span
                  className="ml-1 inline-block h-4 w-[2px] animate-pulse align-middle"
                  style={{ backgroundColor: config.color }}
                />
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            <div className="dashboard-card-muted min-w-0 rounded-2xl border border-white/8 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Confidence
              </div>
              <div className="mt-3 min-w-0">
                <div className="text-[clamp(1.75rem,3vw,2.25rem)] font-semibold leading-none text-white">
                  {confidence}%
                </div>
                <div className="mt-2 text-xs leading-5 text-slate-500">
                  belief strength
                </div>
              </div>
              <div className="mt-3 h-2 rounded-full bg-slate-900/80">
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-out"
                  style={{
                    width: `${confidence}%`,
                    backgroundColor: config.color,
                    boxShadow: `0 0 16px ${config.color}44`,
                  }}
                />
              </div>
            </div>

            <div className="dashboard-card-muted min-w-0 rounded-2xl border border-white/8 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Active signals
              </div>
              <div className="mt-3 text-[clamp(1.75rem,3vw,2.25rem)] font-semibold leading-none text-white">
                {signalCount}
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-500">
                qualified at W{activeWindow}
              </div>
            </div>

            <div className="dashboard-card-muted min-w-0 rounded-2xl border border-white/8 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Trigger gap
              </div>
              <div className="mt-3 text-[clamp(1.75rem,3vw,2.25rem)] font-semibold leading-none text-white">
                {distanceToTrigger > 0 ? distanceToTrigger.toFixed(2) : '0.00'}
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-500">
                remaining to R=3.0
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3">
          <div className="dashboard-card-muted rounded-2xl border border-white/8 p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              Trajectory
            </div>
            <div className="mt-2 text-base font-semibold" style={{ color: config.color }}>
              {insight.trajectoryText}
            </div>
            <div className="mt-3 text-sm leading-6 text-slate-300">
              {operatorTakeaway}
            </div>
          </div>

          <div className="dashboard-card-muted rounded-2xl border border-white/8 p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              Signals in scope
            </div>
            <div className="mt-3 space-y-3">
              {signals.length === 0 ? (
                <div className="rounded-2xl border border-white/8 bg-slate-950/35 px-4 py-3 text-sm text-slate-400">
                  No signals are qualified in this window. The system remains inside its baseline envelope.
                </div>
              ) : (
                signals.map((signal) => (
                  <div
                    key={signal.metric}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-slate-950/35 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {METRIC_LABELS[signal.metric] ?? signal.metric}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {signal.windows_sustained} sustained windows
                      </div>
                    </div>
                    <div className="shrink-0 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-xs text-slate-300">
                      z {signal.z_score.toFixed(1)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="dashboard-card-muted rounded-2xl border border-white/8 p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              Next likely development
            </div>
            <div className="mt-3 text-sm leading-7 text-slate-300">
              {insight.prediction ?? 'No forward projection is needed here because the system is either stable or already in active recovery territory.'}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
        <span>FAULTLINE intelligence layer</span>
        <span>Interpretation only. Detection remains deterministic.</span>
      </div>
    </div>
  )
}

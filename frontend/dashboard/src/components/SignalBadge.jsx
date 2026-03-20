const METRIC_CONFIG = {
  p99_latency_z: {
    label: 'Latency',
    color: '#38BDF8',
    gradient: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(14,165,233,0.05))',
    accent: 'from-sky-400/18 to-sky-400/0',
  },
  retry_rate_z: {
    label: 'Retry',
    color: '#8B5CF6',
    gradient: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(109,40,217,0.05))',
    accent: 'from-violet-400/18 to-violet-400/0',
  },
  error_rate_z: {
    label: 'Errors',
    color: '#F43F5E',
    gradient: 'linear-gradient(135deg, rgba(244,63,94,0.2), rgba(190,24,93,0.05))',
    accent: 'from-rose-400/18 to-rose-400/0',
  },
}

const getSeverityMeta = (zScore) => {
  if (zScore >= 4) {
    return {
      label: 'Severe',
      detail: 'Urgent intervention is needed. This signal is no longer isolated drift.',
      cue: 'Mitigate now',
    }
  }

  if (zScore >= 3) {
    return {
      label: 'Escalating',
      detail: 'Pressure is compounding and increasing the odds of a wider cascade.',
      cue: 'Prepare response',
    }
  }

  return {
    label: 'Elevated',
    detail: 'Above baseline and persistent enough to deserve active monitoring.',
    cue: 'Watch closely',
  }
}

export default function SignalBadge({ signal, index = 0 }) {
  const config = METRIC_CONFIG[signal.metric] ?? {
    label: signal.metric,
    color: '#94A3B8',
    gradient: 'linear-gradient(135deg, rgba(148,163,184,0.18), rgba(51,65,85,0.04))',
    accent: 'from-slate-400/14 to-slate-400/0',
  }

  const progress = Math.min(signal.windows_sustained / 9, 1)
  const severity = getSeverityMeta(signal.z_score)

  return (
    <article
      className="signal-card section-reveal min-w-0 rounded-[28px] border border-white/10 p-5"
      style={{
        backgroundImage: `${config.gradient}, linear-gradient(180deg, rgba(15,23,42,0.92), rgba(15,23,42,0.8))`,
        animationDelay: `${120 + index * 80}ms`,
      }}
    >
      <div
        className="absolute inset-y-6 left-0 w-1 rounded-full"
        style={{ background: config.color, boxShadow: `0 0 20px ${config.color}66` }}
      />
      <div className={`pointer-events-none absolute inset-x-6 top-0 h-20 bg-gradient-to-b ${config.accent}`} />

      <div className="min-w-0 pl-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                className="h-3.5 w-3.5 rounded-full"
                style={{
                  backgroundColor: config.color,
                  boxShadow: `0 0 18px ${config.color}88`,
                }}
              />
              <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
                Active signal
              </div>
            </div>
            <div className="mt-4 text-3xl font-semibold tracking-tight text-white">
              {config.label}
            </div>
            <div className="mt-2 text-sm text-slate-400">
              Qualified and sustained in the active monitoring window.
            </div>
          </div>

          <div
            className="shrink-0 rounded-full border px-4 py-2 text-sm font-semibold"
            style={{
              borderColor: `${config.color}33`,
              background: `${config.color}14`,
              color: config.color,
            }}
          >
            z {signal.z_score.toFixed(1)}
          </div>
        </div>

        <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Severity
              </div>
              <div
                className="mt-3 inline-flex rounded-full border px-3 py-1.5 text-sm font-semibold"
                style={{
                  borderColor: `${config.color}33`,
                  background: `${config.color}18`,
                  color: config.color,
                }}
              >
                {severity.label}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-right">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                Windows
              </div>
              <div className="mt-2 text-3xl font-semibold leading-none text-white">
                {signal.windows_sustained}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                sustained
              </div>
            </div>
          </div>

          <div className="mt-4 text-sm leading-6 text-slate-300">
            {severity.detail}
          </div>

          <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
              Operator cue
            </div>
            <div className="mt-2 text-sm font-medium leading-6 text-slate-200">
              {severity.cue}
            </div>
            <div
              className="mt-3 inline-flex max-w-full rounded-full px-3 py-1 text-xs font-medium"
              style={{
                backgroundColor: `${config.color}14`,
                color: config.color,
              }}
            >
              {Math.round(progress * 100)}% persistent
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
            <span>Persistence</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-slate-950/85">
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-out"
              style={{
                width: `${progress * 100}%`,
                background: `linear-gradient(90deg, ${config.color}, ${config.color}cc)`,
                boxShadow: `0 0 16px ${config.color}55`,
              }}
            />
          </div>
        </div>
      </div>
    </article>
  )
}

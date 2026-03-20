const formatTimestamp = (timestamp) => {
  if (!timestamp) return 'Unknown'

  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return `${timestamp.replace('T', ' ').replace('Z', '')} UTC`
  }

  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(parsed)} UTC`
}

const STATUS_CONFIG = {
  nominal: {
    label: 'System nominal',
    tone: 'Blue',
    color: '#38BDF8',
    badgeClass: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    dotClass: 'bg-sky-400',
  },
  instability: {
    label: 'Instability forming',
    tone: 'Amber',
    color: '#F59E0B',
    badgeClass: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    dotClass: 'bg-amber-400',
  },
  cascade: {
    label: 'Cascade detected',
    tone: 'Red',
    color: '#F43F5E',
    badgeClass: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    dotClass: 'bg-rose-400',
  },
}

const FaultlineMark = () => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export default function MetadataBar({
  serviceId,
  activeWindow,
  triggered,
  outage,
  timestamp,
  totalWindows = 12,
}) {
  const status = outage || triggered
    ? STATUS_CONFIG.cascade
    : activeWindow >= 5
      ? STATUS_CONFIG.instability
      : STATUS_CONFIG.nominal
  const progress = totalWindows > 0 ? (activeWindow / totalWindows) * 100 : 0

  const metadataItems = [
    {
      label: 'Service ID',
      value: `Service ${serviceId}`,
    },
    {
      label: 'Current Window',
      value: `W${activeWindow} / ${totalWindows}`,
    },
    {
      label: 'Observed At',
      value: formatTimestamp(timestamp),
    },
  ]

  return (
    <header className="sticky top-0 z-40 bg-[#0B0F1A]/70 backdrop-blur-2xl">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="dashboard-card dashboard-card-static section-reveal rounded-[30px] px-5 py-5 sm:px-6">
          <div
            className="absolute bottom-0 left-0 h-px rounded-full"
            style={{
              width: `${progress}%`,
              background: `linear-gradient(90deg, ${status.color} 0%, rgba(255,255,255,0.15) 100%)`,
            }}
          />

          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-400/20 via-sky-400/10 to-violet-500/20 text-sky-300 shadow-[0_0_40px_rgba(56,189,248,0.12)]">
                <FaultlineMark />
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
                  Reliability Workspace
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <div className="text-2xl font-semibold tracking-[0.32em] text-white">
                    FAULTLINE
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
                    Live telemetry
                  </span>
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  AI Reliability Intelligence
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4 xl:items-end">
              <div className="grid gap-3 sm:grid-cols-3">
                {metadataItems.map((item, index) => (
                  <div
                    key={item.label}
                    className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-3"
                    style={{ animationDelay: `${index * 70}ms` }}
                  >
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                      {item.label}
                    </div>
                    <div className="mt-1 text-sm font-medium text-slate-100">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
                  Window progress {Math.round(progress)}%
                </div>
                <div className={`inline-flex items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium shadow-[0_18px_40px_-24px_rgba(15,23,42,0.95)] ${status.badgeClass}`}>
                  <span className={`status-pulse h-2.5 w-2.5 rounded-full ${status.dotClass}`} />
                  <span>{status.label}</span>
                  <span className="text-[11px] uppercase tracking-[0.24em] text-current/70">
                    {status.tone}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

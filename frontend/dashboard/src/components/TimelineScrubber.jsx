export default function TimelineScrubber({ activeWindow, onChange, windows }) {
  const getPhaseConfig = (windowNumber) => {
    if (windowNumber >= 8) {
      return {
        label: 'Cascade zone',
        detail: 'Detection active',
        color: '#F43F5E',
        chipClass: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
      }
    }

    if (windowNumber >= 5) {
      return {
        label: 'Instability forming',
        detail: 'Signal convergence rising',
        color: '#F59E0B',
        chipClass: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
      }
    }

    return {
      label: 'Nominal baseline',
      detail: 'No elevated drift',
      color: '#38BDF8',
      chipClass: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    }
  }

  const activeData = windows.find(window => window.window_number === activeWindow)
  const phase = getPhaseConfig(activeWindow)
  const progress = windows.length > 1
    ? ((activeWindow - 1) / (windows.length - 1)) * 100
    : 0
  const formattedTimestamp = activeData?.window_timestamp
    ? activeData.window_timestamp.replace('T', ' ').replace('Z', ' UTC')
    : 'Unavailable'

  const windowStats = [
    {
      label: 'Window indicator',
      value: `W${activeWindow} / ${windows.length}`,
      hint: 'Current playback position',
    },
    {
      label: 'Signal count',
      value: String(activeData?.qualified_signals?.length ?? activeData?.signal_count ?? 0),
      hint: 'Qualified signals in view',
    },
    {
      label: 'R score',
      value: activeData?.R_score?.toFixed(2) ?? '0.00',
      hint: 'Cascade convergence',
    },
    {
      label: 'Observed at',
      value: formattedTimestamp,
      hint: 'UTC event timestamp',
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Timeline Scrubber
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Incident playback with window-aware context
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Scrub across windows to watch the cascade narrative evolve from nominal behavior to deterministic detection.
          </div>
        </div>

        <div className={`inline-flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm font-medium ${phase.chipClass}`}>
          <span
            className="h-2 w-2 rounded-full"
            style={{
              backgroundColor: phase.color,
              boxShadow: `0 0 14px ${phase.color}66`,
            }}
          />
          {phase.label}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {windowStats.map((stat, index) => (
          <div
            key={stat.label}
            className="dashboard-card-muted metric-float rounded-2xl border border-white/8 px-4 py-4"
            style={{ animationDelay: `${index * 0.6}s` }}
          >
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {stat.label}
            </div>
            <div className="mt-2 text-sm font-medium text-slate-100">
              {stat.value}
            </div>
            <div className="mt-2 text-xs text-slate-500">
              {stat.hint}
            </div>
          </div>
        ))}
      </div>

      <div className="timeline-shell rounded-[30px] border border-white/10 p-6 shadow-inner shadow-white/5">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-slate-500">
          <span>Nominal</span>
          <span>{phase.detail}</span>
          <span>Cascade</span>
        </div>

        <div className="mt-5 rounded-full border border-white/8 bg-white/[0.03] px-4 py-3">
          <input
            type="range"
            min={1}
            max={windows.length}
            step={1}
            value={activeWindow}
            onChange={(e) => onChange(e.target.value)}
            className="timeline-slider"
            style={{
              '--slider-accent': phase.color,
              '--slider-fill': `${progress}%`,
            }}
          />
        </div>

        <div className="mt-6 flex items-start justify-between gap-2">
          {windows.map((window) => {
            const isActive = window.window_number === activeWindow
            const windowPhase = getPhaseConfig(window.window_number)

            return (
              <div key={window.window_number} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div
                  className={`h-3 w-3 rounded-full transition-all duration-300 ${isActive ? 'scale-125' : ''}`}
                  style={{
                    backgroundColor: isActive ? windowPhase.color : 'rgba(148, 163, 184, 0.32)',
                    boxShadow: isActive ? `0 0 22px ${windowPhase.color}77` : 'none',
                  }}
                />
                <div className={`text-[11px] ${isActive ? 'font-semibold text-white' : 'text-slate-500'}`}>
                  W{window.window_number}
                </div>
                <div className={`h-8 w-px rounded-full ${isActive ? 'opacity-100' : 'opacity-40'}`} style={{ backgroundColor: isActive ? windowPhase.color : 'rgba(148, 163, 184, 0.28)' }} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        {[
          { label: 'Nominal W1-W4', color: '#38BDF8' },
          { label: 'Instability W5-W7', color: '#F59E0B' },
          { label: 'Cascade W8-W12', color: '#F43F5E' },
        ].map((legendItem) => (
          <div
            key={legendItem.label}
            className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-slate-300"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: legendItem.color,
                boxShadow: `0 0 14px ${legendItem.color}55`,
              }}
            />
            {legendItem.label}
          </div>
        ))}
      </div>
    </div>
  )
}

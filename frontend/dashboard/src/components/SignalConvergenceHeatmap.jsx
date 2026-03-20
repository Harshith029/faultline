const METRICS = [
  { key: 'p99_latency_z', label: 'P99 Latency', color: '#3b82f6' },
  { key: 'retry_rate_z', label: 'Retry Rate', color: '#f59e0b' },
  { key: 'error_rate_z', label: 'Error Rate', color: '#ef4444' },
]

const getHeatColor = (z) => {
  if (z >= 7.0) return '#7f1d1d'
  if (z >= 5.0) return '#991b1b'
  if (z >= 3.0) return '#ef4444'
  if (z >= 2.0) return '#f59e0b'
  if (z >= 1.0) return '#1e3a5f'
  return '#1a1d2e'
}

const isQualified = (window, metricKey) =>
  window.qualified_signals?.some((signal) => signal.metric === metricKey) ?? false

export default function SignalConvergenceHeatmap({ windows, activeWindow }) {
  const activeSignals =
    windows.find((window) => window.window_number === activeWindow)?.qualified_signals?.length ?? 0

  return (
    <div className="w-full overflow-x-auto">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Qualifier matrix
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Signal Convergence Map
          </div>
          <div className="mt-2 text-sm text-slate-400">
            See how multiple anomalous signals stack across windows before the cascade threshold is crossed.
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10">
            Active window W{activeWindow}
          </span>
          <span className="rounded-full bg-sky-500/12 px-3 py-1.5 text-sky-200 ring-1 ring-sky-400/20">
            {activeSignals} qualified signals
          </span>
        </div>
      </div>

      <div className="terminal-panel min-w-[640px] rounded-[28px] border border-white/10 p-4">
        <div className="mb-3 flex items-center">
          <div className="w-24 shrink-0" />
          {windows.map((window) => (
            <div
              key={`hdr-${window.window_number}`}
              className={`flex-1 text-center text-[10px] font-medium uppercase tracking-[0.24em] ${
                window.window_number === activeWindow ? 'text-white' : 'text-slate-500'
              }`}
            >
              W{window.window_number}
            </div>
          ))}
        </div>

        {METRICS.map((metric) => (
          <div key={metric.key} className="mb-3 flex items-center last:mb-0">
            <div className="w-24 shrink-0 pr-3">
              <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                  Metric
                </div>
                <div className="mt-1 text-xs font-semibold" style={{ color: metric.color }}>
                  {metric.label}
                </div>
              </div>
            </div>

            {windows.map((window) => {
              const z = window.metrics[metric.key]
              const qualified = isQualified(window, metric.key)
              const isActive = window.window_number === activeWindow

              let border = '1px solid rgba(148,163,184,0.12)'
              if (qualified) border = '1px solid rgba(255,255,255,0.55)'
              else if (isActive) border = '1px solid rgba(96,165,250,0.7)'

              return (
                <div
                  key={`cell-${metric.key}-${window.window_number}`}
                  title={`W${window.window_number}: z=${z.toFixed(1)}${qualified ? ' qualified' : ''}`}
                  className={`group relative mx-[3px] flex h-11 flex-1 items-center justify-center rounded-2xl transition duration-300 hover:-translate-y-0.5 ${
                    isActive ? 'shadow-[0_0_0_1px_rgba(96,165,250,0.15)]' : ''
                  }`}
                  style={{
                    background: getHeatColor(z),
                    border,
                  }}
                >
                  <span className={`text-[11px] font-semibold ${z >= 2.0 ? 'text-white' : 'text-slate-500'}`}>
                    {z.toFixed(1)}
                  </span>
                  {qualified && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-white shadow-[0_0_14px_rgba(255,255,255,0.85)]" />
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="mr-1 text-slate-500">z-score intensity</span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm border border-white/10 bg-[#1a1d2e]" />
          &lt;1.0
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-[#1e3a5f]" />
          1-2
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-[#f59e0b]" />
          2-3
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-[#ef4444]" />
          3-5
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-[#991b1b]" />
          5+
        </span>
      </div>
    </div>
  )
}

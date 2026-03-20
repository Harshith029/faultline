import SignalBadge from './SignalBadge'

export default function SignalPanel({ signals = [], activeWindow }) {
  const count = signals.length
  const badgeText = `${count} active signal${count === 1 ? '' : 's'}`
  const accentClass = count >= 3
    ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
    : count >= 2
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
      : count === 1
        ? 'border-sky-400/30 bg-sky-400/10 text-sky-200'
        : 'border-slate-400/20 bg-slate-400/10 text-slate-300'

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Signal Panel
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">Active Signals</div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Qualified signals are promoted into focused cards so operators can scan severity, persistence, and metric identity at a glance.
          </div>
        </div>
        <div className={`inline-flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm font-medium ${accentClass}`}>
          <span className="h-2 w-2 rounded-full bg-current" />
          {badgeText}
        </div>
      </div>

      {count === 0 ? (
        <div className="rounded-[28px] border border-emerald-400/20 bg-emerald-400/10 px-6 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="mt-4 text-base font-semibold text-emerald-200">No signals qualified</div>
          <div className="mt-2 text-sm text-slate-400">
            System behavior remains inside the monitored baseline envelope.
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Signals</div>
              <div className="mt-2 text-2xl font-semibold text-white">{count}</div>
              <div className="mt-1 text-xs text-slate-500">Qualified at W{activeWindow}</div>
            </div>
            <div className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Peak Z-score</div>
              <div className="mt-2 text-2xl font-semibold text-white">
                {Math.max(...signals.map(signal => signal.z_score)).toFixed(1)}
              </div>
              <div className="mt-1 text-xs text-slate-500">Highest sustained anomaly</div>
            </div>
            <div className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Max sustained</div>
              <div className="mt-2 text-2xl font-semibold text-white">
                {Math.max(...signals.map(signal => signal.windows_sustained))}w
              </div>
              <div className="mt-1 text-xs text-slate-500">Persistence across the window stream</div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {signals.map((signal, index) => (
              <SignalBadge
                key={signal.metric}
                signal={signal}
                index={index}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

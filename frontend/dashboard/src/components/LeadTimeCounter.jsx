export default function LeadTimeCounter({ activeWindow, outage, detectionWindow }) {
  const detectionWindowNumber = detectionWindow?.window_number ?? 8
  if (activeWindow < detectionWindowNumber) return null

  const outageWindow = 12
  const minutesAhead = Math.max(outageWindow - activeWindow, 0)
  const elapsedProgress = ((activeWindow - detectionWindowNumber + 1) / (outageWindow - detectionWindowNumber + 1)) * 100
  const tone = outage
    ? {
        label: 'Outage in progress',
        description: 'The modeled outage window has been reached. Focus shifts to containment and recovery.',
        className: 'border-rose-400/25 bg-rose-400/10 text-rose-100',
        accent: '#F43F5E',
      }
    : {
        label: `${minutesAhead} minute${minutesAhead === 1 ? '' : 's'} ahead`,
        description: 'Lead time remains before the terminal outage window. Every minute still matters.',
        className: 'border-amber-400/25 bg-amber-400/10 text-amber-100',
        accent: '#F59E0B',
      }

  return (
    <div className={`rounded-[26px] border p-5 ${tone.className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-current/70">
          Lead Time
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-slate-200">
          Detection W{detectionWindowNumber}
        </div>
      </div>

      <div className="mt-4 text-3xl font-semibold text-current">{tone.label}</div>
      <div className="mt-2 text-sm text-slate-300">{tone.description}</div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Current Window</div>
          <div className="mt-1 text-sm font-medium text-white">W{activeWindow}</div>
        </div>
        <div className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Outage Window</div>
          <div className="mt-1 text-sm font-medium text-white">W{outageWindow}</div>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
          <span>Lead-time burn down</span>
          <span>{Math.round(Math.max(elapsedProgress, 12))}% elapsed</span>
        </div>
        <div className="h-2 rounded-full bg-slate-950/70">
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-out"
            style={{
              width: `${Math.max(elapsedProgress, 12)}%`,
              backgroundColor: tone.accent,
              boxShadow: `0 0 16px ${tone.accent}55`,
            }}
          />
        </div>
      </div>
    </div>
  )
}

const GAUGE_MAX = 10
const CENTER = 100
const RADIUS = 74
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const getGaugeColor = (score) => {
  if (score >= 3.0) return '#EF4444'
  if (score >= 2.5) return '#F59E0B'
  return '#38BDF8'
}

const getStatusCopy = (score) => {
  if (score >= 3.0) return { label: 'Cascade detected', tone: 'Critical' }
  if (score >= 2.5) return { label: 'Instability forming', tone: 'Warning' }
  return { label: 'System nominal', tone: 'Healthy' }
}

const polarToCartesian = (cx, cy, radius, angleInDegrees) => {
  const radians = ((angleInDegrees - 90) * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

export default function ConvergenceGauge({ R }) {
  const clamped = Math.min(Math.max(R, 0), GAUGE_MAX)
  const progress = clamped / GAUGE_MAX
  const strokeDashoffset = CIRCUMFERENCE * (1 - progress)
  const color = getGaugeColor(R)
  const status = getStatusCopy(R)
  const marker = polarToCartesian(CENTER, CENTER, RADIUS, progress * 360)
  const distanceToTrigger = Math.max(3 - R, 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Convergence Gauge
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">Cascade Risk</div>
        </div>
        <div
          className="rounded-full border px-3 py-1.5 text-xs font-medium"
          style={{
            borderColor: `${color}33`,
            background: `${color}14`,
            color,
          }}
        >
          {status.tone}
        </div>
      </div>

      <div className="relative mx-auto flex h-72 w-72 items-center justify-center">
        <div
          className="absolute inset-10 rounded-full blur-3xl"
          style={{ background: `${color}26` }}
        />
        <svg viewBox="0 0 200 200" className="h-full w-full overflow-visible">
          <defs>
            <linearGradient id="gauge-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
              <stop offset="18%" stopColor={color} stopOpacity="1" />
              <stop offset="100%" stopColor={color} stopOpacity="0.8" />
            </linearGradient>
          </defs>

          <circle
            cx={CENTER}
            cy={CENTER}
            r={90}
            fill="none"
            stroke="rgba(148, 163, 184, 0.09)"
            strokeWidth="1"
            strokeDasharray="3 8"
            className="gauge-orbit"
          />
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="rgba(148, 163, 184, 0.12)"
            strokeWidth="16"
          />
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="url(#gauge-gradient)"
            strokeWidth="16"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
            style={{
              filter: `drop-shadow(0 0 22px ${color}66)`,
              transition: 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1), stroke 300ms ease',
            }}
          />
          <circle
            cx={marker.x}
            cy={marker.y}
            r="10"
            fill={color}
            opacity="0.2"
            className="gauge-ping"
          />
          <circle
            cx={marker.x}
            cy={marker.y}
            r="5.5"
            fill={color}
            stroke="#E2E8F0"
            strokeWidth="2"
            style={{ filter: `drop-shadow(0 0 10px ${color}88)` }}
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-xs uppercase tracking-[0.24em] text-slate-500">R score</div>
          <div className="mt-3 text-5xl font-semibold" style={{ color }}>
            {R.toFixed(2)}
          </div>
          <div className="mt-2 text-sm text-slate-400">Cascade Risk</div>
          <div className="mt-4 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-400">
            {status.label}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center text-xs">
        <div className="dashboard-card-muted rounded-2xl border border-white/8 px-3 py-3">
          <div className="font-medium text-slate-100">Headroom</div>
          <div className="mt-1 text-slate-400">
            {distanceToTrigger > 0 ? `${distanceToTrigger.toFixed(2)} to trigger` : 'Triggered'}
          </div>
        </div>
        <div className="dashboard-card-muted rounded-2xl border border-white/8 px-3 py-3">
          <div className="font-medium text-slate-100">Trigger</div>
          <div className="mt-1 text-amber-300">R = 3.0</div>
        </div>
        <div className="dashboard-card-muted rounded-2xl border border-white/8 px-3 py-3">
          <div className="font-medium text-slate-100">Scale</div>
          <div className="mt-1 text-slate-400">{Math.round(progress * 100)}% of max</div>
        </div>
      </div>
    </div>
  )
}

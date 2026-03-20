import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from 'recharts'

const getBarColor = (score, isActive) => {
  if (isActive) return '#ffffff'
  if (score >= 3.0) return '#ef4444'
  if (score >= 2.5) return '#f59e0b'
  return '#3b82f6'
}

export default function RiskTimelineChart({ windows, activeWindow }) {
  const chartData = windows.map((window) => ({
    window: window.window_number,
    label: `W${window.window_number}`,
    R: window.R_score,
    triggered: window.triggered,
    outage: window.outage,
  }))

  const activeRisk = chartData.find((window) => window.window === activeWindow)?.R ?? 0
  const highestRisk = Math.max(...chartData.map((window) => window.R))
  const riskTone = activeRisk >= 3 ? 'text-rose-300' : activeRisk >= 2.5 ? 'text-amber-300' : 'text-sky-300'

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Escalation view
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Risk Score Timeline
          </div>
          <div className="mt-2 text-sm text-slate-400">
            Window-by-window cascade risk with trigger and outage markers.
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full px-3 py-1.5 ring-1 ${
            activeRisk >= 3
              ? 'bg-rose-500/15 text-rose-200 ring-rose-400/30'
              : activeRisk >= 2.5
                ? 'bg-amber-500/15 text-amber-200 ring-amber-400/30'
                : 'bg-sky-500/15 text-sky-200 ring-sky-400/30'
          }`}>
            Active risk {activeRisk.toFixed(2)}
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10">
            Peak {highestRisk.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="chart-shell rounded-[28px] border border-white/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-400">
            Active window <span className={`font-semibold ${riskTone}`}>W{activeWindow}</span>
          </div>
          <div className="text-xs text-slate-500">
            Trigger threshold at R=3.0
          </div>
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 6" stroke="rgba(148,163,184,0.12)" />

            <XAxis
              dataKey="window"
              tickFormatter={(value) => `W${value}`}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />

            <YAxis
              domain={[0, 10]}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: 'R Score', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
            />

            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
              contentStyle={{
                background: 'rgba(15, 23, 42, 0.96)',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                borderRadius: '18px',
                fontSize: '12px',
                boxShadow: '0 24px 50px -30px rgba(2, 6, 23, 0.9)',
              }}
              formatter={(value) => [value.toFixed(2), 'R Score']}
              labelFormatter={(label) => {
                const window = chartData.find((item) => item.window === label)
                if (!window) return `Window ${label}`
                const status = window.outage ? ' - OUTAGE' : window.triggered ? ' - TRIGGERED' : ''
                return `Window ${label}${status}`
              }}
            />

            <ReferenceLine
              y={3.0}
              stroke="#ef4444"
              strokeDasharray="4 6"
              label={{ value: 'Trigger R=3.0', position: 'insideTopRight', fill: '#fca5a5', fontSize: 11 }}
            />

            <ReferenceLine
              x={12}
              stroke="#991b1b"
              strokeWidth={2}
              strokeDasharray="2 6"
              label={{ value: 'OUTAGE', position: 'top', fill: '#fda4af', fontSize: 10 }}
            />

            <Bar dataKey="R" radius={[10, 10, 4, 4]} isAnimationActive animationDuration={900}>
              {chartData.map((entry) => (
                <Cell
                  key={`cell-${entry.window}`}
                  fill={getBarColor(entry.R, entry.window === activeWindow)}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

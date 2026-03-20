import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Area,
  AreaChart,
  Dot,
} from 'recharts'

export default function ConfidenceTrendChart({ windows, activeWindow }) {
  const chartData = windows.map((w) => ({
    window: w.window_number,
    confidence: w.confidence,
    confidencePct: Math.round(w.confidence * 100),
    triggered: w.triggered,
    outage: w.outage,
  }))

  const currentConf = chartData.find((d) => d.window === activeWindow)
  const confPct = currentConf?.confidencePct ?? 0
  let confColor = '#3b82f6'
  if (confPct >= 80) confColor = '#10b981'
  else if (confPct >= 50) confColor = '#f59e0b'

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Model alignment
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Detection Confidence
          </div>
          <div className="mt-2 text-sm text-slate-400">
            Confidence builds as more evidence converges across adjacent windows.
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10">
            Active window W{activeWindow}
          </span>
          <span
            className="rounded-full px-3 py-1.5 font-semibold ring-1"
            style={{
              color: confColor,
              backgroundColor: `${confColor}20`,
              borderColor: `${confColor}35`,
            }}
          >
            {confPct}% confidence
          </span>
        </div>
      </div>

      <div className="chart-shell rounded-[28px] border border-white/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3 text-xs">
          <span className="text-slate-400">
            Current classifier certainty for this timeline stage
          </span>
          <span className="text-slate-500">
            Alert checkpoint at W8
          </span>
        </div>

        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="confidenceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={confColor} stopOpacity={0.34} />
                <stop offset="95%" stopColor={confColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 6" stroke="rgba(148,163,184,0.12)" />

            <XAxis
              dataKey="window"
              tickFormatter={(val) => `W${val}`}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />

            <YAxis
              domain={[0, 1]}
              tickFormatter={(val) => `${Math.round(val * 100)}%`}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />

            <Tooltip
              cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }}
              contentStyle={{
                background: 'rgba(15, 23, 42, 0.96)',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                borderRadius: '18px',
                fontSize: '12px',
                boxShadow: '0 24px 50px -30px rgba(2, 6, 23, 0.9)',
              }}
              formatter={(value) => [`${Math.round(value * 100)}%`, 'Confidence']}
              labelFormatter={(label) => `Window ${label}`}
            />

            <ReferenceLine
              x={8}
              stroke="#ef4444"
              strokeDasharray="3 6"
              label={{ value: 'ALERT', position: 'top', fill: '#fda4af', fontSize: 10 }}
            />

            <ReferenceLine
              x={activeWindow}
              stroke="#ffffff"
              strokeDasharray="2 4"
              strokeWidth={1}
            />

            <Area
              type="monotone"
              dataKey="confidence"
              stroke={confColor}
              strokeWidth={2.5}
              fill="url(#confidenceGradient)"
              isAnimationActive
              animationDuration={900}
              dot={(props) => {
                const { cx, cy, payload } = props
                if (payload.window === activeWindow) {
                  return (
                    <Dot
                      key={payload.window}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill="#ffffff"
                      stroke={confColor}
                      strokeWidth={2}
                    />
                  )
                }
                if (payload.triggered) {
                  return (
                    <Dot
                      key={payload.window}
                      cx={cx}
                      cy={cy}
                      r={4}
                      fill="#ef4444"
                      stroke="#ef4444"
                      strokeWidth={1}
                    />
                  )
                }
                return (
                  <Dot
                    key={payload.window}
                    cx={cx}
                    cy={cy}
                    r={2.4}
                    fill={confColor}
                    stroke="none"
                  />
                )
              }}
              activeDot={{ r: 6, fill: '#ffffff', stroke: confColor, strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

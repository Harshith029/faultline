import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer
} from 'recharts'

const METRIC_CONFIG = [
  {
    dataKey: 'p99',
    name: 'Latency',
    color: '#38BDF8',
    gradientId: 'latency-gradient',
    filterId: 'latency-glow',
    description: 'P99 latency drift',
  },
  {
    dataKey: 'retry',
    name: 'Retry',
    color: '#8B5CF6',
    gradientId: 'retry-gradient',
    filterId: 'retry-glow',
    description: 'Client retry amplification',
  },
  {
    dataKey: 'error',
    name: 'Errors',
    color: '#F43F5E',
    gradientId: 'error-gradient',
    filterId: 'error-glow',
    description: 'Downstream error propagation',
  },
]

export default function DriftChart({ windows, activeWindow }) {
  const chartData = windows.map(window => ({
    window: window.window_number,
    label: `W${window.window_number}`,
    p99: window.metrics.p99_latency_z,
    retry: window.metrics.retry_rate_z,
    error: window.metrics.error_rate_z,
    triggered: window.triggered,
    outage: window.outage,
  }))

  const cascadeWindow = windows.find(window => window.triggered)?.window_number
  const activeSnapshot = chartData.find(point => point.window === activeWindow) ?? chartData[0]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Drift Chart
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Multi-signal drift across the incident window
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            The primary observability surface tracks how latency, retry pressure, and errors bend toward deterministic cascade detection.
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {METRIC_CONFIG.map((metric, index) => (
            <div
              key={metric.dataKey}
              className="dashboard-card-muted metric-float rounded-2xl border border-white/8 px-4 py-4"
              style={{ animationDelay: `${index * 0.6}s` }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: metric.color,
                    boxShadow: `0 0 18px ${metric.color}66`,
                  }}
                />
                <div className="text-sm font-medium text-slate-100">{metric.name}</div>
              </div>
              <div className="mt-3 flex items-end gap-2">
                <div className="text-2xl font-semibold text-white">
                  {activeSnapshot?.[metric.dataKey]?.toFixed(1)}
                </div>
                <div className="pb-1 text-[11px] uppercase tracking-[0.2em] text-slate-500">
                  z-score
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">{metric.description}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="chart-shell rounded-[30px] border border-white/10 p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
            Active window W{activeWindow}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">Fixed scale 0-10</span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-amber-200">Threshold z=2</span>
            {cascadeWindow && (
              <span className="rounded-full border border-rose-400/20 bg-rose-400/10 px-3 py-1.5 text-rose-200">
                Cascade marker W{cascadeWindow}
              </span>
            )}
          </div>
        </div>

        <div className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 18, left: -12, bottom: 4 }}>
              <defs>
                <linearGradient id="latency-gradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#7DD3FC" />
                  <stop offset="100%" stopColor="#0EA5E9" />
                </linearGradient>
                <linearGradient id="retry-gradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#C4B5FD" />
                  <stop offset="100%" stopColor="#7C3AED" />
                </linearGradient>
                <linearGradient id="error-gradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#FDA4AF" />
                  <stop offset="100%" stopColor="#F43F5E" />
                </linearGradient>
                <filter id="latency-glow">
                  <feGaussianBlur stdDeviation="3.2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter id="retry-glow">
                  <feGaussianBlur stdDeviation="3.2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter id="error-glow">
                  <feGaussianBlur stdDeviation="3.2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" vertical />

              <XAxis
                dataKey="window"
                tickFormatter={(value) => `W${value}`}
                axisLine={false}
                tickLine={false}
                stroke="#64748b"
                tick={{ fill: '#94a3b8', fontSize: 12 }}
              />

              <YAxis
                domain={[0, 10]}
                axisLine={false}
                tickLine={false}
                stroke="#64748b"
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                label={{ value: 'Z-score', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12 }}
              />

              <Tooltip
                cursor={{ stroke: 'rgba(226, 232, 240, 0.22)', strokeWidth: 1 }}
                contentStyle={{
                  background: 'rgba(15, 23, 42, 0.97)',
                  border: '1px solid rgba(148, 163, 184, 0.18)',
                  borderRadius: '18px',
                  color: '#F8FAFC',
                  fontSize: '12px',
                  boxShadow: '0 26px 70px -36px rgba(15, 23, 42, 0.95)',
                }}
                labelFormatter={(value) => `Window ${value}`}
                formatter={(value, name) => [`z=${Number(value).toFixed(2)}`, name]}
              />

              <ReferenceLine
                y={2.0}
                stroke="#F59E0B"
                strokeDasharray="6 4"
                strokeWidth={1.5}
                label={{ value: 'Threshold z=2', position: 'right', fill: '#F59E0B', fontSize: 11 }}
              />

              {cascadeWindow && (
                <ReferenceLine
                  x={cascadeWindow}
                  stroke="#F43F5E"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{ value: 'Cascade detected', position: 'top', fill: '#F43F5E', fontSize: 11 }}
                />
              )}

              {activeWindow && (
                <ReferenceLine
                  x={activeWindow}
                  stroke="#E2E8F0"
                  strokeWidth={1}
                  strokeOpacity={0.35}
                />
              )}

              {METRIC_CONFIG.map((metric) => (
                <Line
                  key={metric.dataKey}
                  type="monotone"
                  dataKey={metric.dataKey}
                  name={metric.name}
                  stroke={`url(#${metric.gradientId})`}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter={`url(#${metric.filterId})`}
                  dot={false}
                  activeDot={{
                    r: 5,
                    fill: metric.color,
                    stroke: '#0B0F1A',
                    strokeWidth: 2,
                  }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

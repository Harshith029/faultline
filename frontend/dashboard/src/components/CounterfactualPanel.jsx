import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { runCounterfactual, MITIGATIONS } from '../lib/detectionEngine'

// Interactive "what-if": pick a mitigation and the window to act, and the same
// deterministic engine re-runs on the recovered telemetry. Shows the cascade
// flattening — making the lead-time value tangible: act before W8 and the
// outage never happens; act at W8 and you are already mitigating, not preventing.

const ACT_WINDOWS = [5, 6, 7, 8, 9]

const STATUS_STYLE = {
  averted: { ring: 'ring-emerald-400/40', bg: 'bg-emerald-500/10', text: 'text-emerald-200', dot: '#34D399', line: '#34D399' },
  mitigated: { ring: 'ring-amber-400/40', bg: 'bg-amber-500/10', text: 'text-amber-200', dot: '#F59E0B', line: '#F59E0B' },
  failed: { ring: 'ring-rose-400/40', bg: 'bg-rose-500/10', text: 'text-rose-200', dot: '#F43F5E', line: '#F43F5E' },
}

export default function CounterfactualPanel({ raw, engine, params }) {
  const [actWindow, setActWindow] = useState(6)
  const [mitigation, setMitigation] = useState('circuit_breaker')

  const cf = useMemo(
    () => runCounterfactual(raw, { window: actWindow, mitigation, params }),
    [raw, actWindow, mitigation, params]
  )

  const style = STATUS_STYLE[cf.verdict.status] ?? STATUS_STYLE.mitigated
  const originalPeakR = Math.max(...engine.windows.map((w) => w.R_score))

  const chartData = engine.windows.map((w, i) => ({
    window: w.window_number,
    original: w.R_score,
    counterfactual: cf.detection.windows[i].R_score,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Counterfactual · what if you acted?
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Rewind the incident and intervene
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Apply a mitigation at a chosen window. The same deterministic engine re-runs on the recovered
            telemetry — so the averted outcome is computed math, not a scripted replay.
          </div>
        </div>
        <div className={`inline-flex items-center gap-2 self-start rounded-full px-4 py-2 text-sm font-medium ring-1 ${style.bg} ${style.text} ${style.ring}`}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: style.dot }} />
          {cf.verdict.label}
        </div>
      </div>

      {/* Controls */}
      <div className="grid gap-4 lg:grid-cols-[1fr,auto]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Mitigation</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(MITIGATIONS).map(([key, m]) => (
              <button
                key={key}
                onClick={() => setMitigation(key)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  mitigation === key
                    ? 'border-sky-400/40 bg-sky-500/15 text-sky-100'
                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Act at window</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {ACT_WINDOWS.map((w) => {
              const isTriggerWin = w >= (cf.baselineTriggeredAt ?? 8)
              return (
                <button
                  key={w}
                  onClick={() => setActWindow(w)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    actWindow === w
                      ? 'border-white/30 bg-white/15 text-white'
                      : isTriggerWin
                        ? 'border-rose-400/20 bg-rose-500/5 text-rose-300/80 hover:text-rose-200'
                        : 'border-emerald-400/20 bg-emerald-500/5 text-emerald-300/80 hover:text-emerald-200'
                  }`}
                  title={isTriggerWin ? 'At/after the original trigger' : 'Before the original trigger — preventable'}
                >
                  W{w}
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Original trigger at <span className="text-rose-300">W{cf.baselineTriggeredAt ?? 8}</span> — green windows are still preventable.
          </div>
        </div>
      </div>

      {/* Overlay chart */}
      <div className="chart-shell rounded-[28px] border border-white/10 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-2 text-slate-300">
            <span className="h-2.5 w-4 rounded-full" style={{ backgroundColor: '#F43F5E' }} /> Unmitigated cascade
          </span>
          <span className="inline-flex items-center gap-2 text-slate-300">
            <span className="h-2.5 w-4 rounded-full" style={{ backgroundColor: style.line }} /> With mitigation @ W{actWindow}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 6" stroke="rgba(148,163,184,0.12)" />
            <XAxis
              dataKey="window"
              tickFormatter={(v) => `W${v}`}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[0, 13]}
              stroke="rgba(148,163,184,0.16)"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: 'R Score', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
            />
            <Tooltip
              cursor={{ stroke: 'rgba(226,232,240,0.22)', strokeWidth: 1 }}
              contentStyle={{
                background: 'rgba(15, 23, 42, 0.96)',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                borderRadius: '16px',
                fontSize: '12px',
              }}
              labelFormatter={(v) => `Window ${v}`}
              formatter={(value, name) => [Number(value).toFixed(2), name === 'original' ? 'Unmitigated' : 'Mitigated']}
            />
            <ReferenceLine y={params.triggerThreshold} stroke="#ef4444" strokeDasharray="4 6" label={{ value: 'Trigger R=3.0', position: 'insideTopRight', fill: '#fca5a5', fontSize: 10 }} />
            <ReferenceLine x={actWindow} stroke="#e2e8f0" strokeOpacity={0.4} strokeDasharray="2 5" label={{ value: 'Act', position: 'top', fill: '#e2e8f0', fontSize: 10 }} />
            <Line type="monotone" dataKey="original" stroke="#F43F5E" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="counterfactual" stroke={style.line} strokeWidth={3} dot={{ r: 2.5, fill: style.line }} animationDuration={500} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Outcome comparison */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-rose-400/20 bg-rose-500/[0.06] p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-rose-300/80">Without intervention</div>
          <div className="mt-2 text-lg font-semibold text-white">Outage at W{cf.baselineOutageAt ?? 12}</div>
          <div className="mt-1 text-sm text-slate-400">
            Triggered W{cf.baselineTriggeredAt ?? 8} · peak R {originalPeakR.toFixed(2)}
          </div>
        </div>
        <div className={`rounded-2xl border p-4 ${style.bg} ${style.ring} ring-1`}>
          <div className={`text-[10px] uppercase tracking-[0.2em] ${style.text}`}>
            With {MITIGATIONS[mitigation].label.toLowerCase()} @ W{actWindow}
          </div>
          <div className="mt-2 text-lg font-semibold text-white">
            {cf.averted ? 'Outage prevented' : cf.outageAt ? `Outage at W${cf.outageAt}` : 'Outage avoided'}
          </div>
          <div className="mt-1 text-sm text-slate-400">
            {cf.triggeredAt ? `Triggered W${cf.triggeredAt}` : 'Never triggered'} · peak R {cf.peakR.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  )
}

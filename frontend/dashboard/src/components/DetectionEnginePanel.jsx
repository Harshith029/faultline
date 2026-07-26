import { METRIC_META } from '@faultline/core'

const METRIC_ORDER = ['p99_latency', 'retry_rate', 'error_rate']

const fmt = (x, n = 2) => Number(x).toFixed(n)

export default function DetectionEnginePanel({ engine, activeWindow, comparison, params }) {
  const w = engine.windows[activeWindow - 1]
  if (!w) return null

  const { triggerThreshold } = params
  const qualified = w.qualified_signals
  const meanZ = qualified.length
    ? qualified.reduce((a, s) => a + s.z_score, 0) / qualified.length
    : 0

  const verdict = w.outage
    ? { label: 'OUTAGE', cls: 'border-rose-400/40 bg-rose-500/15 text-rose-200' }
    : w.triggered
      ? { label: 'CASCADE TRIGGERED', cls: 'border-rose-400/40 bg-rose-500/15 text-rose-200' }
      : qualified.length > 0
        ? { label: 'WATCHING', cls: 'border-amber-400/40 bg-amber-500/15 text-amber-200' }
        : { label: 'NOMINAL', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200' }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Detection Engine · live math
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Auditable detection, recomputed for W{activeWindow}
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Every number below is derived in your browser from the raw telemetry — z-scores, signal
            qualification and the cascade risk score. Nothing is precomputed; scrub the timeline and the
            math re-runs.
          </div>
        </div>
        <div className={`inline-flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm font-medium ${verdict.cls}`}>
          <span className="h-2 w-2 rounded-full bg-current" />
          {verdict.label}
        </div>
      </div>

      {/* Per-metric z-score derivation */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-[1.2fr,0.8fr,1.4fr,0.9fr] gap-2 border-b border-white/8 px-4 py-3 text-[10px] uppercase tracking-[0.18em] text-slate-500">
          <span>Signal</span>
          <span>Raw</span>
          <span>z = (x − μ) / σ</span>
          <span className="text-right">Status</span>
        </div>
        {METRIC_ORDER.map((key) => {
          const meta = METRIC_META[key]
          const base = engine.baselines[key]
          const raw = w.raw[key]
          const z = w.metrics[meta.zKey]
          const sig = qualified.find((s) => s.metric === meta.zKey)
          const isQualified = Boolean(sig)
          const elevated = z >= params.zThreshold
          const tone = isQualified
            ? 'text-rose-300'
            : elevated
              ? 'text-amber-300'
              : 'text-slate-400'
          const statusLabel = isQualified
            ? `qualified · ${sig.windows_sustained} windows`
            : elevated
              ? 'elevated · not sustained'
              : 'nominal'

          return (
            <div
              key={key}
              className="grid grid-cols-[1.2fr,0.8fr,1.4fr,0.9fr] items-center gap-2 border-b border-white/5 px-4 py-3 text-sm last:border-0"
            >
              <span className="font-medium text-slate-200">{meta.label}</span>
              <span className="font-mono text-slate-300">
                {fmt(raw, key === 'p99_latency' ? 0 : 2)}
                <span className="ml-0.5 text-[11px] text-slate-500">{meta.unit}</span>
              </span>
              <span className="font-mono text-xs text-slate-400">
                ({fmt(raw, key === 'p99_latency' ? 0 : 2)} − {fmt(base.mean, key === 'p99_latency' ? 0 : 2)}) / {fmt(base.sigma, 2)} ={' '}
                <span className={`font-semibold ${tone}`}>{fmt(z)}σ</span>
              </span>
              <span className={`text-right text-xs font-medium ${tone}`}>{statusLabel}</span>
            </div>
          )
        })}
      </div>

      {/* R-score derivation */}
      <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
          Cascade risk score
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-sm text-slate-300">
          <span className="text-slate-500">R =</span>
          <span>mean_z × ln(1 + n) × W</span>
          <span className="text-slate-500">=</span>
          <span>
            {fmt(meanZ)} × ln(1 + {qualified.length}) × {fmt(params.criticalityWeight, 1)}
          </span>
          <span className="text-slate-500">=</span>
          <span className={`text-lg font-semibold ${w.triggered ? 'text-rose-300' : 'text-sky-300'}`}>
            {fmt(w.R_score)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>
            Trigger threshold <span className="font-mono text-slate-300">R ≥ {fmt(triggerThreshold, 1)}</span>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            n = qualified signals = <span className="font-mono text-slate-300">{qualified.length}</span>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            confidence <span className="font-mono text-slate-300">{Math.round(w.confidence * 100)}%</span>
          </span>
        </div>
      </div>

      {/* Baseline comparison */}
      <DetectorComparison comparison={comparison} totalWindows={engine.windows.length} />
    </div>
  )
}

function DetectorComparison({ comparison, totalWindows }) {
  const fl = comparison.faultlineWindow
  const slo = comparison.staticSLO
  const single = comparison.singleMetric

  const rows = [
    {
      name: 'FAULTLINE convergence',
      detail: 'sustained multi-signal drift',
      window: fl,
      color: '#38BDF8',
      lead: 'detection point',
      tone: 'text-sky-300',
    },
    single && {
      name: 'Single-metric 3σ alert',
      detail: single.rule + ' — noisy, fires on any one spike',
      window: single.window,
      color: '#F59E0B',
      lead: single.leadWindows > 0 ? `${single.leadWindows} windows later` : 'same window',
      tone: 'text-amber-300',
    },
    slo && {
      name: 'Static SLO threshold',
      detail: slo.rule + ' — the incumbent: alarms only once you are already failing',
      window: slo.window,
      color: '#F43F5E',
      lead: slo.leadWindows > 0 ? `${slo.leadWindows} windows later` : 'same window',
      tone: 'text-rose-300',
    },
  ].filter(Boolean)

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
          Lead time vs. incumbent alerting
        </div>
        {slo?.leadWindows > 0 && (
          <div className="rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200">
            {slo.leadWindows} windows (~{slo.leadWindows} min) earlier than a static SLO alert
          </div>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-3">
            <div className="w-44 shrink-0">
              <div className="text-sm font-medium text-slate-200">{r.name}</div>
              <div className="text-[11px] text-slate-500">{r.detail}</div>
            </div>
            <div className="relative h-7 flex-1 rounded-full border border-white/8 bg-white/[0.03]">
              {Array.from({ length: totalWindows }).map((_, i) => (
                <span
                  key={i}
                  className="absolute top-1/2 h-1 w-px -translate-y-1/2 bg-white/10"
                  style={{ left: `${(i / (totalWindows - 1)) * 100}%` }}
                />
              ))}
              {r.window != null && (
                <span
                  className="absolute top-1/2 flex h-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-2 text-[11px] font-semibold text-[#0B0F1A]"
                  style={{
                    left: `${((r.window - 1) / (totalWindows - 1)) * 100}%`,
                    backgroundColor: r.color,
                    boxShadow: `0 0 16px ${r.color}66`,
                  }}
                >
                  W{r.window}
                </span>
              )}
            </div>
            <div className={`w-28 shrink-0 text-right text-xs font-medium ${r.tone}`}>{r.lead}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-white/8 pt-3 text-xs text-slate-500">
        The convergence of sustained signals — not any single metric crossing a line — is what lets FAULTLINE
        flag the cascade before error rate breaches its SLO. Detection stays 100% deterministic math; the AI only explains it.
      </div>
    </div>
  )
}

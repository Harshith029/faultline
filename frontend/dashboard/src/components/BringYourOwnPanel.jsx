import { useState } from 'react'
import { runDetection, compareDetectors } from '../lib/detectionEngine'
import { parseTelemetryCsv, EXAMPLE_CSV } from '../lib/parseTelemetry'
import DriftChart from './DriftChart'
import RiskTimelineChart from './RiskTimelineChart'

export default function BringYourOwnPanel() {
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [activeWindow, setActiveWindow] = useState(1)

  const run = (csv) => {
    const { raw, error: parseError } = parseTelemetryCsv(csv)
    if (parseError) {
      setError(parseError)
      setResult(null)
      return
    }
    const detection = runDetection(raw)
    const comparison = compareDetectors(detection)
    setResult({ raw, detection, comparison })
    setError(null)
    setActiveWindow(detection.detectionWindow?.window_number ?? raw.length)
  }

  const onFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result)
      setText(content)
      run(content)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const det = result?.detection
  const cmp = result?.comparison
  const peakR = det ? Math.max(...det.windows.map((w) => w.R_score)) : 0

  const verdict = !det
    ? null
    : det.outageWindow
      ? { label: `Cascade → outage at W${det.outageWindow.window_number}`, cls: 'border-rose-400/40 bg-rose-500/15 text-rose-200', dot: '#F43F5E' }
      : det.detectionWindow
        ? { label: `Cascade detected at W${det.detectionWindow.window_number}`, cls: 'border-rose-400/40 bg-rose-500/15 text-rose-200', dot: '#F43F5E' }
        : { label: 'No cascade detected — nominal', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200', dot: '#38BDF8' }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
            Bring your own telemetry
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Run the engine on your data
          </div>
          <div className="mt-2 max-w-2xl text-sm text-slate-400">
            Paste a CSV (or upload a file) with <span className="font-mono text-slate-300">p99_latency, retry_rate, error_rate</span> columns.
            The same deterministic detector runs on it in your browser — no server, no precomputed answers.
          </div>
        </div>
        {verdict && (
          <div className={`inline-flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm font-medium ${verdict.cls}`}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: verdict.dot }} />
            {verdict.label}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'window,p99_latency,retry_rate,error_rate\n1,112,0.4,0.6\n2,104,0.5,0.2\n...'}
          spellCheck={false}
          rows={7}
          className="w-full resize-y rounded-xl border border-white/10 bg-[#0B0F1A]/70 p-3 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-400/40"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => run(text)}
            className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
          >
            Run detection
          </button>
          <button
            onClick={() => { setText(EXAMPLE_CSV); run(EXAMPLE_CSV) }}
            className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Load example
          </button>
          <label className="cursor-pointer rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-slate-300 transition hover:text-white">
            Upload CSV
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
          </label>
          {(text || result) && (
            <button
              onClick={() => { setText(''); setResult(null); setError(null) }}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-slate-400 transition hover:text-white"
            >
              Clear
            </button>
          )}
        </div>
        {error && (
          <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {det && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: 'Windows analyzed', value: det.windows.length },
              { label: 'Trigger window', value: det.detectionWindow ? `W${det.detectionWindow.window_number}` : '—' },
              { label: 'Peak R score', value: peakR.toFixed(2) },
              {
                label: 'Lead vs static SLO',
                value: cmp?.staticSLO?.leadWindows > 0 ? `${cmp.staticSLO.leadWindows} windows` : '—',
              },
            ].map((s) => (
              <div key={s.label} className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{s.label}</div>
                <div className="mt-1 text-lg font-semibold text-white">{s.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-[28px] border border-white/10 p-4">
            <DriftChart windows={det.windows} activeWindow={activeWindow} />
          </div>
          <div className="rounded-[28px] border border-white/10 p-4">
            <RiskTimelineChart windows={det.windows} activeWindow={activeWindow} />
          </div>
        </div>
      )}
    </div>
  )
}

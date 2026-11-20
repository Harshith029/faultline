import { useState, useMemo } from 'react'
import { fetchTimeline, fetchLiveTelemetry } from '../timelineApi'
import { runDetection, compareDetectors, DEFAULT_PARAMS } from '@faultline/core'
import { RAW_TELEMETRY } from '@faultline/core'
import { liveParamsFor, toPositionalWindows } from '../lib/liveTelemetry'
import MetadataBar from './MetadataBar'
import TimelineScrubber from './TimelineScrubber'
import DetectionEnginePanel from './DetectionEnginePanel'
import CounterfactualPanel from './CounterfactualPanel'
import BringYourOwnPanel from './BringYourOwnPanel'
import AIInsightPanel from './AIInsightPanel'
import HypothesisCard from './HypothesisCard'
import ServiceArchitectureMap from './ServiceArchitectureMap'
import DriftChart from './DriftChart'
import RiskTimelineChart from './RiskTimelineChart'
import ConvergenceGauge from './ConvergenceGauge'
import LeadTimeCounter from './LeadTimeCounter'
import SignalPanel from './SignalPanel'
import SignalConvergenceHeatmap from './SignalConvergenceHeatmap'
import ConfidenceTrendChart from './ConfidenceTrendChart'
import IncidentChatAgent from './IncidentChatAgent'

/**
 * Fixed narrative for the bundled 12-window scenario.
 *
 * This is hand-written demo text, not an analysis. Faultline observes one
 * service at a time and has no topology, traces, or deploy history, so it
 * cannot establish that one service caused another. Everything rendered from
 * this object is labelled as sample scenario content.
 */
const SAMPLE_HYPOTHESIS = {
  generated_by: 'sample',
  root_service: 'service-b',
  mechanism:
    'The scenario models connection-pool exhaustion on service-b: outbound connections saturate, requests queue, and P99 latency climbs. Clients retry, amplifying load until errors appear downstream.',
  cascade_path: 'service-b → service-d → service-f',
  evidence: [
    'P99 latency held above 2σ from W5 onward — the leading indicator in this scenario.',
    'Retry rate qualified at W8, consistent with clients re-issuing slow requests.',
    'Error rate breached its 2% SLO three windows later (W11).',
  ],
}

// Said only when minutes are missing: the engine never lets a sustained run span
// one, and a reader should know why a run restarted.
const liveQualityNote = (quality) => {
  const complete = quality?.windows_complete
  const requested = quality?.windows_requested
  if (!Number.isFinite(complete) || !Number.isFinite(requested) || complete >= requested) return ''
  return ` ${complete} of ${requested} minutes had complete data; a sustained signal never spans a missing minute.`
}

export default function FaultlineDashboard() {
  const [mode, setMode] = useState('scenario')
  const [activeWindow, setActiveWindow] = useState(1)
  const [apiHypothesis, setApiHypothesis] = useState(null)
  const [liveRaw, setLiveRaw] = useState(null)
  const [liveParams, setLiveParams] = useState(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveError, setLiveError] = useState(null)
  const [liveQuality, setLiveQuality] = useState(null)
  const [explanation, setExplanation] = useState({ status: 'idle', error: null })

  const liveAvailable = Boolean(import.meta.env.VITE_API_URL)
  const isLive = mode === 'live' && Array.isArray(liveRaw) && liveRaw.length > 0 && liveParams !== null

  const engine = useMemo(
    () => (isLive ? runDetection(liveRaw, liveParams) : runDetection(RAW_TELEMETRY)),
    [isLive, liveRaw, liveParams]
  )
  const scoredMetrics = engine.params.metrics ?? DEFAULT_PARAMS.metrics
  const comparison = useMemo(() => compareDetectors(engine), [engine])
  const windows = engine.windows

  // Fetched only when asked. Loading the page used to request the timeline by
  // itself, and against an API with Bedrock enabled that could mean a billed
  // model call for every visitor who merely opened the dashboard.
  const loadApiExplanation = () => {
    setExplanation({ status: 'loading', error: null })
    fetchTimeline('B')
      .then((data) => {
        const triggered = data?.windows?.find((w) => w.triggered)
        const hypothesis = triggered?.hypothesis ?? triggered?.hypothesis_fallback
        if (!hypothesis) throw new Error('the API returned no explanation for this timeline')
        setApiHypothesis(hypothesis)
        setExplanation({ status: 'loaded', error: null })
      })
      .catch((err) => setExplanation({ status: 'error', error: err.message }))
  }

  const loadLive = () => {
    setLiveLoading(true)
    setLiveError(null)
    fetchLiveTelemetry()
      .then((data) => {
        if (!Array.isArray(data?.raw) || data.raw.length === 0) {
          throw new Error('no live telemetry returned')
        }
        const params = liveParamsFor(data)
        const rows = toPositionalWindows(data.raw)
        // Fails here, with a readable message, if the rows do not carry every
        // metric the response declared — instead of crashing the render.
        runDetection(rows, params)
        setLiveRaw(rows)
        setLiveParams(params)
        setLiveQuality(data.data_quality ?? null)
        setMode('live')
        setActiveWindow(rows.length)
      })
      .catch((err) => setLiveError(err.message))
      .finally(() => setLiveLoading(false))
  }

  const switchToScenario = () => {
    setMode('scenario')
    setActiveWindow(1)
  }

  const activeWindowData = windows[Math.min(activeWindow, windows.length) - 1]
  const detectionWindow = engine.detectionWindow
  const detectionThreshold = detectionWindow?.window_number ?? 8
  // A hypothesis from the API carries its own provenance; the bundled scenario
  // text is only ever shown for the scenario, never alongside live telemetry.
  const hypothesisSource = apiHypothesis ?? SAMPLE_HYPOTHESIS
  const hypothesis = !isLive && activeWindow >= detectionThreshold ? hypothesisSource : null

  if (!activeWindowData) return null

  const sectionClass = 'dashboard-card rounded-[28px] border border-white/10 p-6 backdrop-blur-sm sm:p-7'

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0B0F1A] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-dashboard-grid opacity-80" />
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="ambient-orb left-[-12rem] top-[-9rem] h-80 w-80 bg-sky-500/30" />
        <div className="ambient-orb right-[-10rem] top-[18%] h-[26rem] w-[26rem] bg-violet-500/25" style={{ animationDelay: '-6s' }} />
        <div className="ambient-orb bottom-[-12rem] left-1/3 h-[30rem] w-[30rem] bg-rose-500/18" style={{ animationDelay: '-11s' }} />
      </div>

      <MetadataBar
        serviceId={isLive ? 'Live' : 'B'}
        activeWindow={activeWindow}
        triggered={activeWindowData.triggered}
        outage={activeWindowData.outage}
        timestamp={activeWindowData.window_timestamp}
        totalWindows={windows.length}
        source={isLive ? 'live' : 'scenario'}
        signalCount={activeWindowData.signal_count}
      />

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:gap-8 lg:px-8 lg:py-10">
        {liveAvailable && (
          <section className={`${sectionClass} section-reveal`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
                  Data source
                </div>
                <div className="mt-2 text-sm text-slate-400">
                  {isLive
                    ? `Real CloudWatch telemetry from the configured API Gateway, one-minute windows over the last hour: p99 latency, the 4XX client-error rate (all client-side errors — not a retry count) and the 5XX error rate. Detection runs live in your browser.${liveQualityNote(liveQuality)}`
                    : 'Curated 12-window cascade scenario: sample data, not your telemetry. Switch to live mode to run the same engine on real API Gateway metrics.'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={switchToScenario}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    !isLive
                      ? 'border-sky-400/40 bg-sky-500/15 text-sky-100'
                      : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-white'
                  }`}
                >
                  Incident scenario
                </button>
                <button
                  onClick={loadLive}
                  disabled={liveLoading}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
                    isLive
                      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100'
                      : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-white'
                  } ${liveLoading ? 'cursor-wait opacity-60' : ''}`}
                >
                  <span className={`h-2 w-2 rounded-full ${isLive ? 'status-pulse bg-emerald-400' : 'bg-slate-500'}`} />
                  {liveLoading ? 'Fetching CloudWatch…' : isLive ? 'Live · refresh' : 'Live telemetry'}
                </button>
              </div>
            </div>
            {liveError && (
              <div className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                Live telemetry unavailable: {liveError}
              </div>
            )}
            {!isLive && (
              <div className="mt-4 flex flex-col gap-3 border-t border-white/8 pt-4 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  {explanation.status === 'loaded'
                    ? 'Showing the explanation the timeline API holds for this scenario.'
                    : 'The scenario’s explanation is sample text. The timeline API can supply its own; if it has Bedrock enabled that may be a billed model call, so it is fetched only when you ask.'}
                </span>
                <button
                  onClick={loadApiExplanation}
                  disabled={explanation.status === 'loading'}
                  className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-slate-300 transition hover:text-white disabled:cursor-wait disabled:opacity-60"
                >
                  {explanation.status === 'loading'
                    ? 'Loading explanation…'
                    : explanation.status === 'loaded'
                      ? 'Reload API explanation'
                      : 'Load API explanation'}
                </button>
              </div>
            )}
            {explanation.status === 'error' && (
              <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                Explanation unavailable: {explanation.error}
              </div>
            )}
          </section>
        )}

        <section className={`${sectionClass} section-reveal reveal-delay-1`}>
          <TimelineScrubber
            activeWindow={activeWindow}
            onChange={(value) => setActiveWindow(Number(value))}
            windows={windows}
            params={engine.params}
            showScenarioLegend={!isLive}
          />
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-2`}>
          <DriftChart
            windows={windows}
            activeWindow={activeWindow}
            metrics={scoredMetrics}
            threshold={engine.params.zThreshold}
          />
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-2`}>
          <DetectionEnginePanel
            engine={engine}
            activeWindow={activeWindow}
            comparison={comparison}
            params={engine.params}
          />
        </section>

        {!isLive && (
          <section className={`${sectionClass} section-reveal reveal-delay-3`}>
            <CounterfactualPanel
              raw={RAW_TELEMETRY}
              engine={engine}
              params={engine.params}
            />
          </section>
        )}

        <section className="grid gap-7 xl:grid-cols-[minmax(320px,380px),1fr]">
          <div className={`${sectionClass} section-reveal reveal-delay-3 flex flex-col gap-6`}>
            <ConvergenceGauge R={activeWindowData.R_score} />
            {!isLive && activeWindow >= detectionThreshold && (
              <LeadTimeCounter
                activeWindow={activeWindow}
                outage={activeWindowData.outage}
                detectionWindow={detectionWindow}
              />
            )}
          </div>

          <div className={`${sectionClass} section-reveal reveal-delay-4`}>
            <SignalPanel
              signals={activeWindowData.qualified_signals}
              activeWindow={activeWindow}
            />
          </div>
        </section>

        {activeWindowData.triggered && hypothesis && (
          <section className={`${sectionClass} hypothesis-reveal`}>
            <HypothesisCard
              hypothesis={hypothesis}
              triggered={activeWindowData.triggered}
              activeWindow={activeWindow}
              detectionWindow={detectionWindow ?? windows[7]}
            />
          </section>
        )}

        {!isLive && (
          <section className="grid gap-7 xl:grid-cols-[1.05fr,0.95fr]">
            <div className={`${sectionClass} section-reveal reveal-delay-5`}>
              <AIInsightPanel
                activeWindow={activeWindow}
                activeWindowData={activeWindowData}
              />
            </div>

            <div className={`${sectionClass} section-reveal reveal-delay-5`}>
              <ServiceArchitectureMap
                windows={windows}
                activeWindow={activeWindow}
              />
            </div>
          </section>
        )}

        <section className="grid gap-7 xl:grid-cols-2">
          <div className={`${sectionClass} section-reveal reveal-delay-6`}>
            <RiskTimelineChart
              windows={windows}
              activeWindow={activeWindow}
            />
          </div>

          <div className={`${sectionClass} section-reveal reveal-delay-6`}>
            <SignalConvergenceHeatmap
              windows={windows}
              activeWindow={activeWindow}
              metrics={scoredMetrics}
              params={engine.params}
            />
          </div>
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-7`}>
          <ConfidenceTrendChart
            windows={windows}
            activeWindow={activeWindow}
          />
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-7`}>
          <BringYourOwnPanel />
        </section>
      </main>

      {!isLive && (
        <IncidentChatAgent
          activeWindow={activeWindow}
          activeWindowData={activeWindowData}
          hypothesis={hypothesis}
        />
      )}
    </div>
  )
}

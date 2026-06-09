import { useState, useEffect, useMemo } from 'react'
import { fetchTimeline } from '../timelineApi'
import { runDetection, compareDetectors } from '../lib/detectionEngine'
import { RAW_TELEMETRY } from '../data/rawTelemetry'
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

const LOCAL_HYPOTHESIS = {
  root_service: 'service-b',
  mechanism:
    'Connection-pool exhaustion on service-b: outbound connections saturate, requests queue, and P99 latency climbs. Clients respond with retries, amplifying load until errors propagate to downstream dependents.',
  cascade_path: 'service-b → service-d → service-f',
  evidence: [
    'P99 latency held above 2σ from W5 onward — the leading indicator of the cascade.',
    'Retry rate qualified at W8 as clients re-issued slow requests, compounding connection-pool pressure.',
    'Error rate breached its SLO three windows later (W11), confirming downstream propagation.',
  ],
}

export default function FaultlineDashboard() {
  const [activeWindow, setActiveWindow] = useState(1)
  const [apiHypothesis, setApiHypothesis] = useState(null)

  const engine = useMemo(() => runDetection(RAW_TELEMETRY), [])
  const comparison = useMemo(() => compareDetectors(engine), [engine])
  const windows = engine.windows

  useEffect(() => {
    fetchTimeline('B')
      .then((data) => {
        const triggered = data?.windows?.find((w) => w.triggered)
        const hypothesis = triggered?.hypothesis ?? triggered?.hypothesis_fallback
        if (hypothesis) setApiHypothesis(hypothesis)
      })
      .catch(() => {})
  }, [])

  const activeWindowData = windows[activeWindow - 1]
  const detectionWindow = engine.detectionWindow
  const detectionThreshold = detectionWindow?.window_number ?? 8
  const hypothesisSource = apiHypothesis ?? LOCAL_HYPOTHESIS
  const hypothesis = activeWindow >= detectionThreshold ? hypothesisSource : null

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
        serviceId="B"
        activeWindow={activeWindow}
        triggered={activeWindowData.triggered}
        outage={activeWindowData.outage}
        timestamp={activeWindowData.window_timestamp}
        totalWindows={windows.length}
      />

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:gap-8 lg:px-8 lg:py-10">
        <section className={`${sectionClass} section-reveal reveal-delay-1`}>
          <TimelineScrubber
            activeWindow={activeWindow}
            onChange={(value) => setActiveWindow(Number(value))}
            windows={windows}
          />
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-2`}>
          <DriftChart
            windows={windows}
            activeWindow={activeWindow}
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

        <section className={`${sectionClass} section-reveal reveal-delay-3`}>
          <CounterfactualPanel
            raw={RAW_TELEMETRY}
            engine={engine}
            params={engine.params}
          />
        </section>

        <section className="grid gap-7 xl:grid-cols-[minmax(320px,380px),1fr]">
          <div className={`${sectionClass} section-reveal reveal-delay-3 flex flex-col gap-6`}>
            <ConvergenceGauge R={activeWindowData.R_score} />
            {activeWindow >= detectionThreshold && (
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

      <IncidentChatAgent
        activeWindow={activeWindow}
        activeWindowData={activeWindowData}
        hypothesis={hypothesis}
      />
    </div>
  )
}

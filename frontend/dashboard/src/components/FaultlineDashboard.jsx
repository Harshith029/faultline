import { useState, useEffect } from 'react'
import { fetchTimeline } from '../timelineApi'
import MetadataBar from './MetadataBar'
import TimelineScrubber from './TimelineScrubber'
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

export default function FaultlineDashboard() {
  const [timelineData, setTimelineData] = useState(null)
  const [activeWindow, setActiveWindow] = useState(1)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchTimeline('B')
      .then(data => setTimelineData(data))
      .catch(err => setError(err.message))
  }, [])

  if (error) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0B0F1A] px-4 py-10 text-slate-100">
        <div className="absolute inset-0 bg-dashboard-grid opacity-80" />
        <div className="ambient-orb left-[-8rem] top-[-8rem] h-64 w-64 bg-rose-500/30" />
        <div className="dashboard-card section-reveal relative w-full max-w-md rounded-[28px] border border-red-500/30 bg-red-500/10 p-8 text-center backdrop-blur-sm">
          <div className="text-lg font-semibold text-red-200">
            Failed to load timeline data
          </div>
          <div className="mt-3 text-sm text-red-100/90">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-red-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-red-400"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!timelineData) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0B0F1A] px-4 py-10 text-slate-100">
        <div className="absolute inset-0 bg-dashboard-grid opacity-80" />
        <div className="ambient-orb left-[-10rem] top-[-8rem] h-72 w-72 bg-sky-500/30" />
        <div className="ambient-orb right-[-10rem] top-1/3 h-80 w-80 bg-violet-500/25" style={{ animationDelay: '-7s' }} />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-300 shadow-[0_0_60px_rgba(56,189,248,0.18)]">
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="text-3xl font-semibold tracking-[0.32em] text-white">
            FAULTLINE
          </div>
          <div className="text-sm text-slate-400">
            AI Reliability Intelligence
          </div>
          <div className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-sky-400" />
            Booting observability workspace
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-500">
            {[
              'Analyzing service telemetry...',
              'Running drift detection across 12 windows...',
              'Synthesizing root cause hypothesis...',
            ].map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const windowMap = Object.fromEntries(
    timelineData.windows.map(window => [window.window_number, window])
  )
  const activeWindowData = windowMap[activeWindow]
  const detectionWindow = timelineData.windows.find(window => window.triggered) ?? null
  const detectionThreshold = detectionWindow?.window_number ?? 8
  const hypothesis = activeWindow >= detectionThreshold
    ? detectionWindow?.hypothesis ?? detectionWindow?.hypothesis_fallback ?? null
    : null

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
        totalWindows={timelineData.windows.length}
      />

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:gap-8 lg:px-8 lg:py-10">
        <section className={`${sectionClass} section-reveal reveal-delay-1`}>
          <TimelineScrubber
            activeWindow={activeWindow}
            onChange={(value) => setActiveWindow(Number(value))}
            windows={timelineData.windows}
          />
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-2`}>
          <DriftChart
            windows={timelineData.windows}
            activeWindow={activeWindow}
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
              detectionWindow={detectionWindow ?? windowMap[8]}
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
              windows={timelineData.windows}
              activeWindow={activeWindow}
            />
          </div>
        </section>

        <section className="grid gap-7 xl:grid-cols-2">
          <div className={`${sectionClass} section-reveal reveal-delay-6`}>
            <RiskTimelineChart
              windows={timelineData.windows}
              activeWindow={activeWindow}
            />
          </div>

          <div className={`${sectionClass} section-reveal reveal-delay-6`}>
            <SignalConvergenceHeatmap
              windows={timelineData.windows}
              activeWindow={activeWindow}
            />
          </div>
        </section>

        <section className={`${sectionClass} section-reveal reveal-delay-7`}>
          <ConfidenceTrendChart
            windows={timelineData.windows}
            activeWindow={activeWindow}
          />
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

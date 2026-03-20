import { useState, useRef, useEffect } from 'react'

const cleanText = (value = '') => String(value).replace(/\s+/g, ' ').trim()

const METRIC_LABELS = {
  p99_latency_z: 'Latency',
  retry_rate_z: 'Retry',
  error_rate_z: 'Errors',
}

const QA_PAIRS = [
  {
    id: 'why-failed',
    category: 'Root Cause',
    hint: 'Trace the first failing condition.',
    question: 'Why did service-b fail?',
    answer: 'Service B experienced connection pool exhaustion triggered by a sustained retry storm. Starting at W5, p99 latency crossed 2 sigma and never recovered. By W7, retry rate joined at 3.5 sigma, so clients were amplifying load through backoff loops faster than the pool could drain. At W8, all three metrics qualified simultaneously, pushing the R score to 3.12 and triggering the alert before the outage.',
  },
  {
    id: 'user-load',
    category: 'Load Dynamics',
    hint: 'Explain traffic and feedback loops.',
    question: 'How did user load contribute?',
    answer: 'Elevated user traffic increased request volume to service-b beyond its connection pool capacity. Pool exhaustion forced clients into retry loops, which compounded the load. Each retry added more connections to an already saturated pool and created a classic feedback loop. The retry rate crossing threshold at W7 is the clearest sign of that amplification pattern.',
  },
  {
    id: 'fix-first',
    category: 'Mitigation',
    hint: 'Prioritize the first intervention.',
    question: 'Which service should we fix first?',
    answer: 'Service B is the root cause, so fix it first. The fastest sequence is to stop the retry storm, increase the connection pool headroom, and add backpressure to upstream callers. Services D and F are cascade victims and should recover once service-b stabilizes.',
  },
  {
    id: 'catch-earlier',
    category: 'Lead Time',
    hint: 'Look for earlier warning signals.',
    question: 'Could this have been caught earlier?',
    answer: 'Yes, likely at W6. P99 latency had already remained above 2 sigma for three consecutive windows, and retry rate was climbing toward threshold. A lower trigger threshold could have alerted earlier, though that would trade for more false positives.',
  },
  {
    id: 'blast-radius',
    category: 'Impact',
    hint: 'Map affected services.',
    question: 'What is the blast radius?',
    answer: 'Three services are clearly affected: service-b as the root cause, service-d as the first downstream dependency, and service-f as the second downstream dependency. The current cascade path is B -> D -> F.',
  },
  {
    id: 'retry-spike',
    category: 'Signal Meaning',
    hint: 'Interpret the strongest amplifier.',
    question: 'What does the retry rate spike mean?',
    answer: 'The retry spike is the strongest sign of client-side amplification. Each retry adds new pressure to an already exhausted pool, accelerating degradation. Without intervention, this pattern tends to end in full service unavailability.',
  },
  {
    id: 'do-now',
    category: 'Response Plan',
    hint: 'Summarize immediate operator actions.',
    question: 'What should we do right now?',
    answer: 'Immediate actions in priority order: circuit break service-b to stop retries, shed non-critical load, scale the connection pool if possible, notify downstream owners, and follow up with adaptive retry plus jitter after recovery.',
  },
]

const getStatusMeta = (activeWindowData) => {
  if (activeWindowData?.outage) {
    return {
      label: 'Outage active',
      badge: 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30',
      color: '#F43F5E',
      summary: 'Impact is active. Contain blast radius and restore capacity first.',
    }
  }

  if (activeWindowData?.triggered) {
    return {
      label: 'Cascade detected',
      badge: 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30',
      color: '#F59E0B',
      summary: 'The trigger threshold has been crossed. The best move now is to slow propagation.',
    }
  }

  return {
    label: 'Monitoring',
    badge: 'bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/30',
    color: '#38BDF8',
    summary: 'The system is still under watch. Focus on persistence and avoid overreacting to single-window noise.',
  }
}

const getPrimaryAction = (activeWindowData, hypothesis) => {
  if (activeWindowData?.outage) {
    return 'Contain impact, restore service-b capacity, and coordinate downstream recovery.'
  }

  if (activeWindowData?.triggered) {
    return `Intervene on ${cleanText(hypothesis?.root_service ?? 'service-b')} before blast radius expansion becomes harder to reverse.`
  }

  const signalCount = activeWindowData?.qualified_signals?.length ?? 0

  if (signalCount >= 2) {
    return 'Prepare mitigation now. Multi-signal convergence is forming a real cascade setup.'
  }

  if (signalCount === 1) {
    return 'Keep the lead signal under watch and verify whether another metric starts to converge.'
  }

  return 'No immediate intervention is required. Maintain watch on the active window and trend direction.'
}

const getPathNodes = (hypothesis) =>
  cleanText(hypothesis?.cascade_path ?? '')
    .split(/\s*->\s*/)
    .map((node) => node.trim())
    .filter(Boolean)

export default function IncidentChatAgent({ activeWindow, activeWindowData, hypothesis }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [isTyping, setIsTyping] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [showPromptRail, setShowPromptRail] = useState(true)
  const [selectedPromptId, setSelectedPromptId] = useState(null)
  const messagesEndRef = useRef(null)
  const replyTimeoutRef = useRef(null)
  const messageIdRef = useRef(1)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isTyping])

  useEffect(() => () => {
    if (replyTimeoutRef.current) {
      clearTimeout(replyTimeoutRef.current)
    }
  }, [])

  const nextMessageId = () => {
    const nextId = messageIdRef.current
    messageIdRef.current += 1
    return nextId
  }

  const handleQuestion = (qa) => {
    if (isTyping) return

    setSelectedPromptId(qa.id)
    setShowPromptRail(false)
    setShowContext(false)
    setMessages((prev) => [
      ...prev,
      {
        id: nextMessageId(),
        role: 'user',
        text: qa.question,
      },
    ])

    setIsTyping(true)

    if (replyTimeoutRef.current) {
      clearTimeout(replyTimeoutRef.current)
    }

    replyTimeoutRef.current = setTimeout(() => {
      setIsTyping(false)
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId(),
          role: 'agent',
          text: cleanText(qa.answer),
        },
      ])
      replyTimeoutRef.current = null
    }, 1200)
  }

  const statusMeta = getStatusMeta(activeWindowData)
  const signalCount = activeWindowData?.qualified_signals?.length ?? 0
  const confidence = Math.round((activeWindowData?.confidence ?? 0) * 100)
  const pathNodes = getPathNodes(hypothesis)
  const primaryAction = getPrimaryAction(activeWindowData, hypothesis)
  const activeSignals = activeWindowData?.qualified_signals ?? []
  const responseCount = messages.filter((message) => message.role === 'agent').length
  const hasConversation = messages.length > 0 || isTyping
  const selectedPrompt = QA_PAIRS.find((qa) => qa.id === selectedPromptId) ?? null

  const quickFacts = [
    { label: 'W', value: String(activeWindow) },
    { label: 'R', value: activeWindowData?.R_score?.toFixed(2) ?? '--' },
    { label: 'Conf', value: `${confidence}%` },
    { label: 'Signals', value: String(signalCount) },
  ]

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm transition duration-300 ${
          isOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setIsOpen(false)}
      />

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? 'Close AI analyst' : 'Open AI analyst'}
        title={isOpen ? 'Close AI analyst' : 'Open AI analyst'}
        className={`fixed bottom-5 z-50 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/88 text-sky-200 shadow-[0_26px_70px_-34px_rgba(2,6,23,0.95)] backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:border-sky-400/30 hover:bg-slate-900/95 ${
          isOpen ? 'right-[29rem]' : 'right-5'
        }`}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400/25 via-violet-400/20 to-rose-400/20 shadow-[0_0_30px_rgba(56,189,248,0.18)]">
          {isOpen ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3a3 3 0 0 1 3 3v1.2a2.8 2.8 0 0 0 .82 1.98l.85.85A2.8 2.8 0 0 1 17.5 12a2.8 2.8 0 0 1-.83 1.97l-.85.85A2.8 2.8 0 0 0 15 16.8V18a3 3 0 1 1-6 0v-1.2a2.8 2.8 0 0 0-.82-1.98l-.85-.85A2.8 2.8 0 0 1 6.5 12c0-.74.3-1.45.83-1.97l.85-.85A2.8 2.8 0 0 0 9 7.2V6a3 3 0 0 1 3-3Z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9.5 10.5h5M9 13.5h6" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </button>

      <aside
        className={`fixed right-0 top-0 z-50 flex h-screen w-full max-w-[440px] flex-col overflow-hidden border-l border-white/10 bg-[#0B0F1A]/97 p-4 shadow-[0_32px_90px_-38px_rgba(2,6,23,0.95)] backdrop-blur-2xl transition duration-300 lg:max-w-[460px] ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="shrink-0 rounded-[28px] border border-white/10 bg-gradient-to-br from-slate-900/95 via-slate-900/78 to-slate-950/88 px-4 py-4 shadow-[0_22px_60px_-40px_rgba(2,6,23,0.95)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400/20 via-violet-400/16 to-rose-400/16 text-sky-200 shadow-[0_0_36px_rgba(56,189,248,0.18)]">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M7 8.5a5 5 0 0 1 10 0c0 1.8-.66 2.8-1.6 4.05-.7.93-1.4 1.98-1.65 3.45h-3.5c-.25-1.47-.95-2.52-1.65-3.45C7.66 11.3 7 10.3 7 8.5Z" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M9.5 18h5M10.5 21h3" strokeLinecap="round" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500">
                    FAULTLINE AI
                  </div>
                  <div className="mt-1 text-lg font-semibold text-white">
                    AI Analyst
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-[11px] font-medium ${statusMeta.badge}`}>
                {statusMeta.label}
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                aria-label="Close AI analyst"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          <div
            className="mt-3 rounded-[22px] border px-4 py-3"
            style={{
              borderColor: `${statusMeta.color}33`,
              background: `linear-gradient(135deg, ${statusMeta.color}18, rgba(15,23,42,0.28))`,
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                  Live brief
                </div>
                <div
                  className="mt-2 text-sm font-semibold leading-6 text-white"
                  style={hasConversation ? {
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  } : undefined}
                >
                  {primaryAction}
                </div>
                {!hasConversation && (
                  <div className="mt-2 text-sm leading-6 text-slate-300">
                    {statusMeta.summary}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowContext((prev) => !prev)}
                className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
              >
                {showContext ? 'Less' : 'More'}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              {quickFacts.map((fact) => (
                <div
                  key={fact.label}
                  className="rounded-2xl border border-white/10 bg-slate-950/40 px-2 py-2.5 text-center"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-slate-500">
                    {fact.label}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-white">
                    {fact.value}
                  </div>
                </div>
              ))}
            </div>

            {showContext && (
              <div className="mt-3 space-y-3">
                {pathNodes.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                      Cascade path
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {pathNodes.map((node, index) => (
                        <span key={`${node}-${index}`} className="contents">
                          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200">
                            {node}
                          </span>
                          {index < pathNodes.length - 1 && (
                            <span className="text-xs text-slate-500">-&gt;</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {activeSignals.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                      Signals in scope
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {activeSignals.map((signal) => (
                        <span
                          key={signal.metric}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                        >
                          {METRIC_LABELS[signal.metric] ?? signal.metric} z {signal.z_score.toFixed(1)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 shrink-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                Prompt rail
              </div>
              <div className="mt-1 text-sm text-slate-300">
                {hasConversation ? 'Collapsed after selection so replies stay visible.' : 'Click a guided question to send it to the analyst.'}
              </div>
            </div>
            {hasConversation && (
              <button
                type="button"
                onClick={() => setShowPromptRail((prev) => !prev)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
              >
                {showPromptRail ? 'Hide prompts' : 'More prompts'}
              </button>
            )}
          </div>

          {(!hasConversation || showPromptRail) ? (
            <div className="rail-scroll flex gap-2 overflow-x-auto pb-1">
              {QA_PAIRS.map((qa) => (
                <button
                  type="button"
                  key={qa.id}
                  onClick={() => handleQuestion(qa)}
                  disabled={isTyping}
                  className={`min-w-[180px] rounded-[20px] border px-4 py-3 text-left transition ${
                    isTyping
                      ? 'cursor-not-allowed border-white/10 bg-white/5 text-slate-500 opacity-60'
                      : selectedPromptId === qa.id
                        ? 'border-sky-400/25 bg-sky-400/10'
                        : 'border-white/10 bg-slate-950/55 hover:-translate-y-0.5 hover:border-sky-400/25 hover:bg-sky-400/8'
                  }`}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                    {qa.category}
                  </div>
                  <div className="mt-2 text-sm font-medium leading-6 text-slate-100">
                    {qa.question}
                  </div>
                  {!hasConversation && (
                    <div className="mt-1 text-xs text-slate-500">
                      {qa.hint}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-[20px] border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {selectedPrompt ? `Last prompt: ${selectedPrompt.question}` : 'Prompt rail is collapsed.'}
            </div>
          )}
        </div>

        <div className="mt-3 flex min-h-0 flex-1 flex-col rounded-[26px] border border-white/10 bg-slate-950/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                Conversation
              </div>
              <div className="mt-1 text-sm text-slate-300">
                {responseCount > 0 ? `${responseCount} analyst response${responseCount === 1 ? '' : 's'}` : 'Replies stay centered in this main workspace.'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setMessages([])
                setShowPromptRail(true)
              }}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
            >
              Clear
            </button>
          </div>

          <div className="chat-scroll mt-3 flex-1 overflow-y-auto pr-1">
            {messages.length === 0 && !isTyping ? (
              <div className="terminal-panel rounded-[24px] border border-dashed border-white/10 px-5 py-10 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-400/20 via-violet-400/15 to-rose-400/15 text-sky-200 shadow-[0_0_45px_rgba(56,189,248,0.16)]">
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" strokeLinecap="round" />
                    <circle cx="12" cy="12" r="3.5" />
                  </svg>
                </div>
                <div className="mt-5 text-lg font-semibold text-white">
                  Analyst ready
                </div>
                <div className="mt-2 text-sm leading-6 text-slate-400">
                  Choose a prompt from the rail above. Once you do, the rail collapses so the reply stays visible.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((message) => (
                  <div key={message.id} className="stagger-item">
                    {message.role === 'user' ? (
                      <div className="ml-auto max-w-[88%] rounded-[22px] rounded-br-md border border-sky-400/25 bg-gradient-to-br from-sky-500/20 to-sky-400/8 px-4 py-3 text-sm leading-6 text-white shadow-[0_20px_44px_-30px_rgba(56,189,248,0.45)]">
                        {message.text}
                      </div>
                    ) : (
                      <div className="max-w-[96%]">
                        <div className="terminal-panel rounded-[22px] rounded-tl-md border border-white/10 px-4 py-4 text-sm leading-7 text-slate-200 shadow-[0_24px_50px_-34px_rgba(2,6,23,0.95)]">
                          <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500">
                            <span className="h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.7)]" />
                            FAULTLINE AI
                          </div>
                          {message.text}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {isTyping && (
                  <div className="stagger-item max-w-[96%]">
                    <div className="terminal-panel rounded-[22px] rounded-tl-md border border-white/10 px-4 py-4 shadow-[0_24px_50px_-34px_rgba(2,6,23,0.95)]">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-slate-400"
                          style={{ animationDelay: '0s' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-slate-400"
                          style={{ animationDelay: '0.15s' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-slate-400"
                          style={{ animationDelay: '0.3s' }}
                        />
                        <span className="ml-2 text-xs uppercase tracking-[0.24em] text-slate-500">
                          Building answer...
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {!hasConversation && (
            <div className="mt-3 rounded-[20px] border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-6 text-slate-500">
              The analyst interprets the current timeline and qualified signals only. Detection logic and API behavior remain unchanged.
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

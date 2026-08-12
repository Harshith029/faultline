const GITHUB_URL = 'https://github.com/Harshith029/faultline'

const FaultlineMark = ({ className = 'h-6 w-6' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const STATS = [
  { value: '3 windows', label: 'earlier than static SLO alerts' },
  { value: '100%', label: 'deterministic detection math' },
  { value: '<1 ms', label: 'engine runtime, in your browser' },
  { value: '12', label: 'window incident playback' },
]

const FEATURES = [
  {
    title: 'Deterministic detection engine',
    body: 'Z-score drift, sustained-signal qualification, and cascade risk scoring computed live from raw telemetry. Every number on screen can be re-derived by hand.',
    tag: 'Engine',
  },
  {
    title: 'Lead time you can measure',
    body: 'A built-in comparison shows exactly when a static SLO alert and a single-metric spike detector would fire on the same data — and how much earlier convergence detection does.',
    tag: 'Benchmark',
  },
  {
    title: 'Optional model-written summary',
    body: 'When a Bedrock model is configured, the detection window is summarised in plain language, constrained to the one service that drifted and to the signals the detector actually qualified. It explains; it never detects, and it is not a root-cause claim.',
    tag: 'Bedrock (optional)',
  },
  {
    title: 'Counterfactual simulation',
    body: 'Rewind the incident, apply a circuit breaker or load shedding at any window, and watch the same engine re-run on the recovered telemetry. Act early and the outage never happens.',
    tag: 'What-if',
  },
  {
    title: 'Bring your own telemetry',
    body: 'Paste or upload a CSV of latency, retry, and error series. The full pipeline runs on your data client-side — nothing leaves the browser.',
    tag: 'Your data',
  },
  {
    title: 'Signal visualization',
    body: 'Drift charts, risk timelines, and signal convergence heatmaps for the service under evaluation, plus an illustrative scenario topology that is clearly marked as sample content.',
    tag: 'Dashboard',
  },
]

const STEPS = [
  {
    step: '01',
    title: 'Normalize',
    formula: 'z = (x − μ) / σ',
    body: 'Every metric is scored against its own healthy baseline, making latency, retries, and errors comparable on one scale.',
  },
  {
    step: '02',
    title: 'Qualify',
    formula: 'z ≥ 2.0 for ≥ 2 windows',
    body: 'Single-window spikes are ignored. Only drift that sustains across consecutive windows counts as a signal.',
  },
  {
    step: '03',
    title: 'Score & trigger',
    formula: 'R = mean_z × ln(1 + n) × W',
    body: 'Converging signals compound the risk score. When R crosses 3.0, detection fires — on the math alone, with or without a model configured.',
  },
]

export default function LandingPage({ onLaunch }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0B0F1A] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-dashboard-grid opacity-80" />
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="ambient-orb left-[-12rem] top-[-9rem] h-80 w-80 bg-sky-500/30" />
        <div className="ambient-orb right-[-10rem] top-[22%] h-[26rem] w-[26rem] bg-violet-500/25" style={{ animationDelay: '-6s' }} />
        <div className="ambient-orb bottom-[-14rem] left-1/3 h-[30rem] w-[30rem] bg-rose-500/15" style={{ animationDelay: '-11s' }} />
      </div>

      <header className="sticky top-0 z-40 bg-[#0B0F1A]/70 backdrop-blur-2xl">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <a href="#top" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/20 bg-gradient-to-br from-sky-400/20 via-sky-400/10 to-violet-500/20 text-sky-300">
              <FaultlineMark className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold tracking-[0.28em] text-white">FAULTLINE</span>
          </a>
          <div className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
            <a href="#product" className="transition hover:text-white">Product</a>
            <a href="#how" className="transition hover:text-white">How it works</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition hover:text-white">GitHub</a>
          </div>
          <button
            onClick={onLaunch}
            className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white shadow-[0_12px_30px_-12px_rgba(56,189,248,0.7)] transition hover:bg-sky-400"
          >
            Launch live demo
          </button>
        </nav>
      </header>

      <main id="top" className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <section className="flex flex-col items-center pb-20 pt-16 text-center sm:pt-24">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-xs text-slate-300">
            <span className="status-pulse h-2 w-2 rounded-full bg-sky-400" />
            AWS Builder Center AIdeas Challenge — Top 300 Finalist
          </div>

          <h1 className="mt-8 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl">
            See the outage
            <span className="bg-gradient-to-r from-sky-300 via-sky-400 to-violet-400 bg-clip-text text-transparent"> before it happens</span>
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-relaxed text-slate-400 sm:text-lg">
            FAULTLINE watches each service for sustained drift converging across several metrics at
            once — latency, retries, and errors moving together — and fires earlier than any one of
            them would alone. Deterministic math detects; a model can optionally summarise. It triages
            per-service drift, and does not infer causality between services.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={onLaunch}
              className="rounded-full bg-sky-500 px-6 py-3 text-sm font-semibold text-white shadow-[0_18px_44px_-16px_rgba(56,189,248,0.8)] transition hover:bg-sky-400"
            >
              Launch live demo
            </button>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-slate-200 transition hover:border-white/30 hover:text-white"
            >
              View source
            </a>
          </div>

          <div className="mt-16 grid w-full max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="dashboard-card-muted rounded-2xl border border-white/8 px-4 py-5">
                <div className="text-2xl font-semibold text-white">{s.value}</div>
                <div className="mt-1.5 text-xs leading-relaxed text-slate-400">{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="product" className="pb-20">
          <div className="mx-auto max-w-2xl text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-400/80">Product</div>
            <h2 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
              Reliability intelligence, not another alert
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-slate-400 sm:text-base">
              Static thresholds fire when you are already failing. FAULTLINE watches how signals move
              together over time, quantifies the risk of a forming cascade, and hands engineers a
              diagnosis instead of a page.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="dashboard-card rounded-[24px] border border-white/10 p-6 backdrop-blur-sm">
                <div className="inline-flex rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-200">
                  {f.tag}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-white">{f.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-slate-400">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="pb-20">
          <div className="mx-auto max-w-2xl text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-400/80">How it works</div>
            <h2 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
              Three steps, fully auditable
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-slate-400 sm:text-base">
              Detection never depends on a model you cannot inspect. The entire pipeline is three
              equations you can verify by hand — and rerun on your own data in the demo.
            </p>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.step} className="dashboard-card rounded-[24px] border border-white/10 p-6 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <span className="text-3xl font-semibold text-white/15">{s.step}</span>
                  <span className="rounded-lg border border-white/10 bg-[#0B0F1A]/80 px-3 py-1.5 font-mono text-xs text-sky-300">
                    {s.formula}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-white">{s.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-slate-400">{s.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-[24px] border border-white/10 bg-white/[0.02] p-6 text-center">
            <p className="text-sm text-slate-400">
              Detection is deterministic math only. A model may explain a detection — never cause one.
            </p>
          </div>
        </section>

        <section className="pb-24">
          <div className="dashboard-card relative overflow-hidden rounded-[28px] border border-sky-400/20 p-10 text-center backdrop-blur-sm sm:p-14">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-500/10 via-transparent to-violet-500/10" />
            <h2 className="relative text-3xl font-semibold text-white sm:text-4xl">
              Walk through a worked incident scenario
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-400 sm:text-base">
              Scrub a 12-window incident from nominal to outage, watch detection fire three windows
              early, test counterfactual mitigations, then run the engine on your own telemetry.
            </p>
            <button
              onClick={onLaunch}
              className="relative mt-8 rounded-full bg-sky-500 px-7 py-3 text-sm font-semibold text-white shadow-[0_18px_44px_-16px_rgba(56,189,248,0.8)] transition hover:bg-sky-400"
            >
              Launch live demo
            </button>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-4 py-10 text-sm text-slate-500 sm:px-6 md:flex-row lg:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400">
              <FaultlineMark className="h-4 w-4" />
            </span>
            <span>FAULTLINE — per-service multivariate drift triage</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition hover:text-slate-300">GitHub</a>
            <a href="mailto:harshith.pali3286@gmail.com" className="transition hover:text-slate-300">Contact</a>
            <span>Open source — MIT licensed</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

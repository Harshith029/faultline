import { lazy, Suspense, useEffect, useState } from 'react'
import LandingPage from './components/LandingPage'

const FaultlineDashboard = lazy(() => import('./components/FaultlineDashboard'))

const getView = () => (window.location.hash === '#demo' ? 'demo' : 'landing')

function BootScreen() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0B0F1A] px-4 py-10 text-slate-100">
      <div className="absolute inset-0 bg-dashboard-grid opacity-80" />
      <div className="ambient-orb left-[-10rem] top-[-8rem] h-72 w-72 bg-sky-500/30" />
      <div className="relative flex flex-col items-center gap-3 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-300 shadow-[0_0_60px_rgba(56,189,248,0.18)]">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="text-3xl font-semibold tracking-[0.32em] text-white">FAULTLINE</div>
        <div className="mt-2 flex items-center gap-2 text-sm text-slate-300">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-sky-400" />
          Loading reliability workspace
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [view, setView] = useState(getView)

  useEffect(() => {
    const onHashChange = () => {
      setView(getView())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (view === 'demo') {
    return (
      <Suspense fallback={<BootScreen />}>
        <FaultlineDashboard />
      </Suspense>
    )
  }

  return <LandingPage onLaunch={() => { window.location.hash = 'demo' }} />
}

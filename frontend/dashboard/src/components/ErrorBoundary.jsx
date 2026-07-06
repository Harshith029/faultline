import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0B0F1A] px-4 py-10 text-slate-100">
        <div className="absolute inset-0 bg-dashboard-grid opacity-80" />
        <div className="dashboard-card relative w-full max-w-md rounded-[28px] border border-rose-400/30 bg-rose-500/10 p-8 text-center backdrop-blur-sm">
          <div className="text-lg font-semibold text-rose-200">Something went wrong</div>
          <div className="mt-3 text-sm text-rose-100/80">
            The workspace hit an unexpected error. Reloading usually resolves it.
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-rose-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-rose-400"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

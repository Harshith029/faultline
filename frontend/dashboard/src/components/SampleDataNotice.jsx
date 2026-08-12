/**
 * Marks content that is fixed demo text rather than an observation.
 *
 * Every panel carrying scripted narrative renders one of these. The point is
 * that a viewer should never have to guess whether what they are reading came
 * from the detector or from a script written in advance.
 */
export default function SampleDataNotice({ children, className = '' }) {
  return (
    <div
      data-testid="sample-data-notice"
      className={`flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-100/90 ${className}`}
    >
      <span aria-hidden="true" className="mt-[1px] text-amber-300">
        ▲
      </span>
      <span>
        <span className="font-semibold uppercase tracking-[0.14em] text-amber-200">Sample scenario</span>
        {' — '}
        {children}
      </span>
    </div>
  )
}

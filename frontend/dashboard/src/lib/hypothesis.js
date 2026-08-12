/**
 * Shared parsing and provenance helpers for hypothesis content.
 *
 * Two components previously parsed `cascade_path` with different separators —
 * one on the Unicode arrow, one on ASCII `->` — so at most one of them could
 * ever render a real model response correctly. This is the single parser both
 * use, and it accepts every separator a model plausibly emits.
 */

const SEPARATORS = /\s*(?:→|-+>|=+>|➜|»|\|)\s*/

// `String(null)` is "null", so nullish input has to be handled before coercion
// or a missing field renders as the literal text "null".
export const cleanText = (value) =>
  value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim()

export function parsePath(path) {
  const text = cleanText(path)
  if (!text) return []
  return text
    .split(SEPARATORS)
    .map((node) => node.trim())
    .filter(Boolean)
}

/**
 * Where a hypothesis came from, and therefore how it may be labelled.
 *
 * `sample` content is fixed text written by hand for the demo scenario. It is
 * never a model output and must never be presented as one.
 */
export function provenanceOf(hypothesis) {
  if (!hypothesis) return null
  if (hypothesis.generated_by === 'bedrock') {
    return {
      kind: 'model',
      label: 'Model-generated summary',
      detail: hypothesis.model_id ? `Amazon Bedrock · ${hypothesis.model_id}` : 'Amazon Bedrock',
      badge: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
    }
  }
  if (hypothesis.generated_by === 'fallback' || hypothesis.deterministic) {
    return {
      kind: 'deterministic',
      label: 'Deterministic summary',
      detail: 'Generated from qualified signals — no model involved',
      badge: 'border-sky-400/30 bg-sky-500/10 text-sky-200',
    }
  }
  return {
    kind: 'sample',
    label: 'Sample scenario content',
    detail: 'Fixed demo text. Not a model output and not derived from live telemetry.',
    badge: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
  }
}

/**
 * The detector evaluates one service at a time and has no dependency graph, so
 * a multi-node "cascade path" is only meaningful for the scripted scenario.
 */
export const isSingleService = (hypothesis) => parsePath(hypothesis?.cascade_path).length <= 1

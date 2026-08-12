import { describe, test, expect } from 'vitest'
import { parsePath, provenanceOf, isSingleService, cleanText } from '../src/lib/hypothesis'

describe('cascade path parsing', () => {
  // The bug this replaces: HypothesisCard split on the Unicode arrow while the
  // chat panel split on ASCII "->", so at most one of them could ever render a
  // real model response correctly.
  test('parses the Unicode arrow the Lambda prompt used to request', () => {
    expect(parsePath('service-b → service-d → service-f')).toEqual([
      'service-b',
      'service-d',
      'service-f',
    ])
  })

  test('parses the ASCII arrow the chat panel used to expect', () => {
    expect(parsePath('B -> D -> F')).toEqual(['B', 'D', 'F'])
  })

  test('parses both arrow styles identically', () => {
    expect(parsePath('a → b')).toEqual(parsePath('a -> b'))
  })

  test('tolerates irregular spacing and longer arrows', () => {
    expect(parsePath('a-->b')).toEqual(['a', 'b'])
    expect(parsePath('a  →   b')).toEqual(['a', 'b'])
    expect(parsePath('a => b')).toEqual(['a', 'b'])
  })

  test('a single service yields one node, not an empty path', () => {
    expect(parsePath('service-b')).toEqual(['service-b'])
  })

  test('empty and missing input yield an empty array rather than throwing', () => {
    expect(parsePath('')).toEqual([])
    expect(parsePath(undefined)).toEqual([])
    expect(parsePath(null)).toEqual([])
  })

  test('isSingleService distinguishes real single-service output from scenario paths', () => {
    expect(isSingleService({ cascade_path: 'service-b' })).toBe(true)
    expect(isSingleService({ cascade_path: 'service-b → service-d' })).toBe(false)
  })

  test('cleanText collapses whitespace', () => {
    expect(cleanText('  a\n  b  ')).toBe('a b')
  })
})

describe('provenance labelling', () => {
  test('a Bedrock-generated hypothesis is labelled as a model output', () => {
    const p = provenanceOf({ generated_by: 'bedrock', model_id: 'anthropic.claude-3-haiku' })
    expect(p.kind).toBe('model')
    expect(p.detail).toContain('anthropic.claude-3-haiku')
  })

  test('content with no provenance is treated as sample data, never as AI', () => {
    const p = provenanceOf({ root_service: 'service-b' })
    expect(p.kind).toBe('sample')
    expect(p.label).toBe('Sample scenario content')
    expect(p.detail).toMatch(/Not a model output/)
  })

  test('a deterministic fallback is not labelled as a model output', () => {
    const p = provenanceOf({ generated_by: 'fallback' })
    expect(p.kind).toBe('deterministic')
    expect(p.detail).toMatch(/no model involved/)
  })

  test('a missing hypothesis has no provenance', () => {
    expect(provenanceOf(null)).toBeNull()
  })
})

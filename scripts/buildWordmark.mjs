import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Draws the FAULTLINE wordmark as geometric paths.
 *
 * The banner previously relied on a font stack (Impact, Arial Black, …), which
 * renders differently or falls back to a thin weight on machines lacking those
 * faces. Letterforms built from primitives look identical everywhere, which is
 * what a logo has to do.
 *
 * Glyphs live on a 100-unit cap-height grid with a 22-unit stem.
 */
const GLYPHS = {
  F: { w: 66, rects: [[0, 0, 22, 100], [0, 0, 66, 22], [0, 39, 56, 20]] },
  A: { w: 74, rects: [[0, 0, 22, 100], [52, 0, 22, 100], [0, 0, 74, 22], [22, 44, 30, 20]] },
  U: { w: 74, rects: [[0, 0, 22, 100], [52, 0, 22, 100], [0, 78, 74, 22]] },
  L: { w: 62, rects: [[0, 0, 22, 100], [0, 78, 62, 22]] },
  T: { w: 74, rects: [[0, 0, 74, 22], [26, 0, 22, 100]] },
  I: { w: 22, rects: [[0, 0, 22, 100]] },
  N: {
    w: 74,
    rects: [[0, 0, 22, 100], [52, 0, 22, 100]],
    polys: [[[22, 0], [44, 0], [74, 100], [52, 100]]],
  },
  E: { w: 66, rects: [[0, 0, 22, 100], [0, 0, 66, 22], [0, 39, 56, 20], [0, 78, 66, 22]] },
}

const WORD = 'FAULTLINE'
const GAP = 16

export function wordmarkWidth() {
  return [...WORD].reduce((sum, ch) => sum + GLYPHS[ch].w, 0) + GAP * (WORD.length - 1)
}

/** Emits the glyph shapes, laid out left to right, in a 100-unit cap height. */
function wordmarkShapes(indent) {
  const pad = ' '.repeat(indent)
  const out = []
  let x = 0

  for (const ch of WORD) {
    const glyph = GLYPHS[ch]
    for (const [rx, ry, rw, rh] of glyph.rects ?? []) {
      out.push(`${pad}<rect x="${x + rx}" y="${ry}" width="${rw}" height="${rh}"/>`)
    }
    for (const poly of glyph.polys ?? []) {
      const points = poly.map(([px, py]) => `${x + px},${py}`).join(' ')
      out.push(`${pad}<polygon points="${points}"/>`)
    }
    x += glyph.w + GAP
  }
  return out.join('\n')
}

const W = wordmarkWidth()
const bannerScale = 1
const bannerX = Math.round((1200 - W * bannerScale) / 2)
const bannerY = 40

const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="320" viewBox="0 0 1200 320" role="img" aria-label="FAULTLINE — cascade failure detection">
  <defs>
    <linearGradient id="b-word" gradientUnits="userSpaceOnUse" x1="${bannerX}" y1="0" x2="${bannerX + W}" y2="0">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="40%" stop-color="#818CF8"/>
      <stop offset="70%" stop-color="#C084FC"/>
      <stop offset="100%" stop-color="#F43F5E"/>
    </linearGradient>
    <linearGradient id="b-line" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="60%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#F43F5E"/>
    </linearGradient>
    <pattern id="b-grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0 H0 V40" fill="none" stroke="#151E33" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="1200" height="320" fill="#080B12"/>
  <rect width="1200" height="320" fill="url(#b-grid)" opacity="0.55"/>
  <rect x="1.5" y="1.5" width="1197" height="317" rx="5" fill="none" stroke="#1E293B" stroke-width="3"/>

  <!-- Type band: y 40-190. Drawn as paths, so no font is required anywhere. -->
  <g transform="translate(${bannerX + 6} ${bannerY + 6})" fill="#2A1F5C" opacity="0.9">
${wordmarkShapes(4)}
  </g>
  <g transform="translate(${bannerX} ${bannerY})" fill="url(#b-word)">
${wordmarkShapes(4)}
  </g>

  <text x="600" y="182" text-anchor="middle"
        font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="18" font-weight="600" letter-spacing="8" fill="#94A3B8">
    CASCADE FAILURE DETECTION
  </text>

  <!-- Motif band: y 205-300. Strictly below the type. -->
  <g>
    <line x1="150" y1="286" x2="1050" y2="286" stroke="#1E293B" stroke-width="1.5"/>
    <path d="M150 272 H430 L480 270 L530 267 L580 269 L630 263 L670 257 L720 240 L780 230 L840 224 L900 218 L960 214 L1050 210"
          fill="none" stroke="url(#b-line)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="720" y1="207" x2="720" y2="292" stroke="#F43F5E" stroke-width="2" stroke-dasharray="7 8" opacity="0.75"/>
    <circle cx="720" cy="240" r="8" fill="#080B12" stroke="#F43F5E" stroke-width="3.5"/>

    <g font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="12.5">
      <text x="150" y="308" fill="#475569">nominal</text>
      <text x="736" y="308" font-weight="700" fill="#F87171">detection fires here</text>
      <text x="1050" y="204" text-anchor="end" fill="#64748B">outage</text>
    </g>
  </g>
</svg>
`

// Lockup: mark on the left, wordmark scaled to a 34-unit cap height.
const logoScale = 0.34
const logoX = 140
const logoY = 40

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="140" viewBox="0 0 560 140" role="img" aria-label="FAULTLINE">
  <defs>
    <linearGradient id="l-word" gradientUnits="userSpaceOnUse" x1="${logoX}" y1="0" x2="${logoX + W * logoScale}" y2="0">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="45%" stop-color="#818CF8"/>
      <stop offset="100%" stop-color="#F43F5E"/>
    </linearGradient>
    <linearGradient id="l-drift" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#38BDF8"/>
      <stop offset="55%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#F43F5E"/>
    </linearGradient>
    <linearGradient id="l-plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141A2A"/>
      <stop offset="100%" stop-color="#0B0F1A"/>
    </linearGradient>
  </defs>

  <rect width="560" height="140" rx="22" fill="#0B0F1A"/>
  <rect x="10" y="18" width="104" height="104" rx="26" fill="url(#l-plate)" stroke="#1E293B" stroke-width="2"/>
  <path d="M26 86 H50" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
  <path d="M50 86 L62 80 L70 70 L78 52 L86 30"
        fill="none" stroke="url(#l-drift)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M70 24 V116" stroke="#F43F5E" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="6 7" opacity="0.85"/>
  <circle cx="70" cy="70" r="6.5" fill="#0B0F1A" stroke="#F43F5E" stroke-width="3"/>

  <g transform="translate(${logoX} ${logoY}) scale(${logoScale})" fill="url(#l-word)">
${wordmarkShapes(4)}
  </g>

  <text x="${logoX + 2}" y="102" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif"
        font-size="13" font-weight="500" letter-spacing="2.4" fill="#64748B">CASCADE FAILURE DETECTION</text>
</svg>
`

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
writeFileSync(join(assets, 'banner.svg'), banner)
writeFileSync(join(assets, 'logo.svg'), logo)
process.stdout.write(`wordmark width ${W} units\n`)
process.stdout.write(`banner  wordmark x ${bannerX}..${bannerX + W}, cap height 100\n`)
process.stdout.write(`logo    wordmark x ${logoX}..${Math.round(logoX + W * logoScale)}, cap height ${100 * logoScale}\n`)

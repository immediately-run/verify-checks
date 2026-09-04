import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fastGlob from 'fast-glob'
import { ratchet } from './baseline.mjs'

export async function checkDeadCss({
  cssGlobs,
  sourceGlobs,
  baselinePath,
  cwd = process.cwd(),
} = {}) {
  if (!cssGlobs || cssGlobs.length === 0) {
    throw new Error('check-dead-css: cssGlobs is required (e.g. ["src/**/*.css"])')
  }
  if (!sourceGlobs || sourceGlobs.length === 0) {
    throw new Error('check-dead-css: sourceGlobs is required (e.g. ["src/**/*.{ts,tsx,html,mdx}"])')
  }
  if (!baselinePath) {
    throw new Error('check-dead-css: baselinePath is required (e.g. "verify-baselines/dead-css.json")')
  }
  const cssFiles = fastGlob.sync(cssGlobs, { cwd }).map((path) => ({
    path,
    text: readFileSync(resolve(cwd, path), 'utf8'),
  }))
  const sourceTexts = fastGlob
    .sync(sourceGlobs, { cwd })
    .map((path) => readFileSync(resolve(cwd, path), 'utf8'))
  const findings = findDeadSelectors({ cssFiles, sourceTexts })
  await ratchet({ check: 'dead-css', findings, baselinePath, cwd })
}

// Selector extraction and dead-CSS detection. The CSS scan is a structural
// walk (comment stripping, brace-depth block splitting, string/`@keyframes`
// removal), not a records parser — and its behaviour on real-world CSS is
// frozen by the fixture test in test/dead-css.test.ts, which runs it over a
// dated snapshot of landing-page's src/App.css and asserts the measured
// dead-selector set.

export function stripCssNoise(css) {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // drop string literals so a "}" inside content:"..." cannot split blocks
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
  // unquoted url() bodies (data URIs) can carry braces; drop them wholesale
  out = out.replace(/url\([^)]*\)/gi, 'url()')
  // drop @keyframes blocks entirely (balanced braces), so their from/to/percent
  // inner blocks are never mistaken for selectors
  let previous
  do {
    previous = out
    out = out.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  } while (out !== previous)
  return out
}

// Structural walk: split the stylesheet at every brace, tracking depth, so a
// selector's visibility does not depend on a `}` or line-start anchor — the
// first rule inside an @media block must be extracted exactly like a
// top-level one. Each block carries the prelude text that preceded its `{`.
function walkBlocks(cleaned) {
  const blocks = []
  let depth = 0
  let current = ''
  for (const ch of cleaned) {
    if (ch === '{') {
      blocks.push({ prelude: current.trim(), depth })
      current = ''
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      current = ''
    } else {
      current += ch
    }
  }
  return blocks
}

export function extractSelectors(cssText, { filePath = 'inline.css' } = {}) {
  const cleaned = stripCssNoise(cssText)
  const selectors = []
  for (const { prelude } of walkBlocks(cleaned)) {
    if (prelude === '' || prelude.startsWith('@')) continue
    for (const compound of prelude.split(',')) {
      const trimmed = compound.trim()
      if (trimmed === '' || trimmed.startsWith('@')) continue
      // pseudo-classes, pseudo-elements and attribute selectors are ignored:
      // their markup usage is not visible to a class-name search
      if (trimmed.includes(':') || trimmed.includes('[')) continue
      for (const token of trimmed.matchAll(/([.#][-\w]+)/g)) {
        selectors.push(`${filePath}:${token[1]}`)
      }
    }
  }
  return [...new Set(selectors)]
}

export function sourceWords(texts) {
  const words = new Set()
  for (const text of texts) {
    for (const word of text.split(/[^-\w]+/)) {
      if (word !== '') words.add(word)
    }
  }
  return words
}

export function findDeadSelectors({ cssFiles, sourceTexts }) {
  const words = sourceWords(sourceTexts)
  const dead = []
  for (const { path, text } of cssFiles) {
    for (const fingerprint of extractSelectors(text, { filePath: path })) {
      const name = fingerprint.slice(fingerprint.lastIndexOf(':') + 2)
      if (!words.has(name)) dead.push(fingerprint)
    }
  }
  return dead.sort()
}

import { readFileSync } from 'node:fs'
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
    text: readFileSync(path, 'utf8'),
  }))
  const sourceTexts = fastGlob.sync(sourceGlobs, { cwd }).map((path) => readFileSync(path, 'utf8'))
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
  // drop @keyframes blocks entirely (balanced braces), so their from/to/percent
  // inner blocks are never mistaken for selectors
  let previous
  do {
    previous = out
    out = out.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  } while (out !== previous)
  return out
}

export function extractSelectors(cssText, { filePath = 'inline.css' } = {}) {
  const cleaned = stripCssNoise(cssText)
  const selectors = []
  const blockPattern = /(^|\})\s*([^{}@][^{}]*)\{/g
  let match
  while ((match = blockPattern.exec(cleaned)) !== null) {
    const selectorList = match[2]
    for (const compound of selectorList.split(',')) {
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

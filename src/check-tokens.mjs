import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fastGlob from 'fast-glob'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import { ratchet } from './baseline.mjs'
import { CSS_NAMED_COLORS } from './cssNamedColors.mjs'

// check-tokens — every var() resolves to a declared token, and no raw colours
// outside token declarations (R3-743; plans/design-system-conformance step A1).
//
// Two finding kinds, both fingerprinted into the shrink-only ratchet:
//   undeclared|<file>|--name                       — a var() reference no scanned CSS declares
//   literal|<file>|<selector>|<property>|<literal> — a colour literal in an ordinary declaration
//   stale-allow|--name                             — an allow entry that CSS declares or nothing references
//
// CSS is parsed with postcss (declarations are the unit of truth); values with
// postcss-value-parser. TS/TSX references are a lexical token search on
// purpose: the claim "this file mentions --x" is lexical, and a hit in a
// comment is a real finding (the comment is lying).

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
])
// Keywords that are never colour literals, whatever property they land on.
const EXCLUDED_WORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none'])
const NAMED_COLORS = new Set(CSS_NAMED_COLORS)
const SOURCE_VAR_REFERENCE = /var\(\s*(--[\w-]+)/g

function validateAllow(allow) {
  if (allow === undefined || allow === null) return {}
  if (typeof allow !== 'object' || Array.isArray(allow)) {
    throw new Error('check-tokens: allow must be a map from token name to reason')
  }
  for (const [name, reason] of Object.entries(allow)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`check-tokens: allow entry ${name} needs a non-empty reason string`)
    }
  }
  return allow
}

// The selector a declaration answers to: the nearest Rule ancestor, with the
// preludes of any enclosing at-rules prefixed outermost-first, so a finding
// inside `@media (max-width: 900px) { .x { … } }` names both.
function selectorOf(decl) {
  const preludes = []
  let selector = null
  for (let node = decl.parent; node; node = node.parent) {
    if (node.type === 'rule' && selector === null) {
      selector = node.selector
    } else if (node.type === 'atrule') {
      preludes.unshift(`@${node.name} ${node.params}`.trim())
    }
  }
  return [...preludes, selector ?? '(no selector)'].join(' > ')
}

// Every var() reference in a declaration value, fallback arguments included
// (a fallback does not excuse an undeclared name; nested var()s in fallbacks
// are references too).
function collectVarReferences(value) {
  const names = []
  valueParser(value).walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'var') return
    const nameNode = node.nodes.find((child) => child.type === 'word')
    if (nameNode) names.push(nameNode.value)
  })
  return names
}

// Colour literals in an ordinary declaration's value. var() contents are
// skipped wholesale (a fallback is not a separate literal) and so are url()
// bodies (a fragment id like #abc123 is not a colour). color-mix() is not a
// literal in itself, but its arguments are judged.
function collectLiterals(value) {
  const literals = []
  valueParser(value).walk((node) => {
    if (node.type === 'function') {
      const name = node.value.toLowerCase()
      if (name === 'var' || name === 'url') return false
      if (COLOR_FUNCTIONS.has(name)) {
        literals.push(valueParser.stringify(node))
        return false
      }
      return // color-mix and anything else: judge the arguments
    }
    if (node.type === 'word') {
      if (HEX_COLOR.test(node.value)) {
        literals.push(node.value)
      } else {
        const lowered = node.value.toLowerCase()
        if (NAMED_COLORS.has(lowered) && !EXCLUDED_WORDS.has(lowered)) literals.push(node.value)
      }
    }
  })
  return literals
}

function analyzeTokens({ cssFiles, sourceFiles, allow }) {
  const allowed = validateAllow(allow)
  const declared = new Set()
  const references = [] // { file, name }
  const findings = []
  let referenceCount = 0

  for (const { path, text } of cssFiles) {
    const root = postcss.parse(text, { from: path })
    root.walkDecls((decl) => {
      const names = collectVarReferences(decl.value)
      referenceCount += names.length
      for (const name of names) references.push({ file: path, name })
      if (decl.prop.startsWith('--')) {
        declared.add(decl.prop)
        return // a custom-property declaration IS a token; its value is not scanned for literals
      }
      for (const literal of collectLiterals(decl.value)) {
        findings.push(`literal|${path}|${selectorOf(decl)}|${decl.prop}|${literal}`)
      }
    })
  }

  for (const { path, text } of sourceFiles ?? []) {
    for (const match of text.matchAll(SOURCE_VAR_REFERENCE)) {
      referenceCount += 1
      references.push({ file: path, name: match[1] })
    }
  }

  const undeclared = new Set()
  for (const { file, name } of references) {
    if (!declared.has(name) && !(name in allowed)) undeclared.add(`undeclared|${file}|${name}`)
  }
  findings.push(...undeclared)

  const referencedNames = new Set(references.map(({ name }) => name))
  for (const name of Object.keys(allowed)) {
    if (declared.has(name) || !referencedNames.has(name)) findings.push(`stale-allow|${name}`)
  }

  return { findings: [...new Set(findings)].sort(), declaredCount: declared.size, referenceCount }
}

export function findTokenFindings({ cssFiles, sourceFiles, allow } = {}) {
  return analyzeTokens({ cssFiles, sourceFiles, allow }).findings
}

// The glob + read layer, exported so tests drive the exact consumer shape
// (cssGlobs: ['src/**/*.css'], cwd: the fixture root). Throwing on zero
// matched CSS files here is half of the non-vacuous-by-construction rule —
// a directory path silently matching nothing is how R3-674 went unseen.
export function loadTokenInputs({ cssGlobs, sourceGlobs = [], cwd = process.cwd() } = {}) {
  if (!cssGlobs || cssGlobs.length === 0) {
    throw new Error('check-tokens: cssGlobs is required (e.g. ["src/**/*.css"])')
  }
  const read = (globs) =>
    fastGlob.sync(globs, { cwd }).map((path) => ({ path, text: readFileSync(resolve(cwd, path), 'utf8') }))
  const cssFiles = read(cssGlobs)
  if (cssFiles.length === 0) {
    throw new Error(`check-tokens: cssGlobs matched zero files (globs: ${cssGlobs.join(', ')}; cwd ${cwd})`)
  }
  return { cssFiles, sourceFiles: read(sourceGlobs) }
}

export async function checkTokens({ cssGlobs, sourceGlobs, allow, baselinePath, cwd = process.cwd() } = {}) {
  if (!baselinePath) {
    throw new Error('check-tokens: baselinePath is required (e.g. "verify-baselines/tokens.json")')
  }
  const { cssFiles, sourceFiles } = loadTokenInputs({ cssGlobs, sourceGlobs, cwd })
  const { findings, declaredCount, referenceCount } = analyzeTokens({ cssFiles, sourceFiles, allow })
  if (declaredCount === 0) {
    throw new Error(
      `check-tokens: zero custom properties declared in ${cssGlobs.join(', ')} — ` +
        'a repo with truly no tokens does not adopt this check',
    )
  }
  if (referenceCount === 0) {
    throw new Error(
      `check-tokens: zero var() references found in ${cssGlobs.join(', ')} / ${(sourceGlobs ?? []).join(', ')} — ` +
        'the scan is vacuous; check the globs',
    )
  }
  await ratchet({ check: 'check-tokens', findings, baselinePath, cwd })
}

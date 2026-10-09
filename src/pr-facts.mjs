// pr-facts (R3-1080) — the PR body's factual sections (Tests added, Untested
// and why) generated from the head commit, so they cannot go stale between
// review rounds. Pure functions here; bin/pr-facts.mjs only parses argv and
// does I/O.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const BLOCK_BEGIN_PREFIX = '<!-- pr-facts:begin head='
export const BLOCK_END = '<!-- pr-facts:end -->'

export function beginMarker(head) {
  return `${BLOCK_BEGIN_PREFIX}${head} -->`
}

// Test titles come from the TypeScript AST, never a regex (R12). `typescript`
// resolves from the TARGET repo, not from this package — every target repo has
// it installed, and a peer dep here would pin the consumer's compiler version.
export function loadTypescript(cwd) {
  let ts
  try {
    ts = createRequire(join(cwd, 'package.json'))('typescript')
  } catch {
    throw new Error(`pr-facts: cannot resolve typescript from ${cwd} — the target repo must have it installed (npm ci)`)
  }
  if (typeof ts.createSourceFile !== 'function') {
    throw new Error(
      `pr-facts: the typescript resolved from ${cwd} (v${ts.version ?? '?'}) has no createSourceFile — ` +
        'the classic compiler API is required (typescript 7 native does not expose it)',
    )
  }
  return ts
}

function titleFromArg(node, ts, fileName, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart(source))
  return `<dynamic title> (${fileName}:${line + 1})`
}

// Walks CallExpressions whose callee is describe|it|test (or their
// .only/.skip/.each members), joining nested describe titles with ' › '.
export function testTitles(sourceText, fileName, ts) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const titles = []
  const visit = (node, prefix) => {
    if (ts.isCallExpression(node)) {
      // An intermediate call in an .each chain (the `it.each([…])` inside
      // `it.each([…])('title', fn)`) carries the table, not the title — the
      // OUTER call's arguments do. Skip it.
      const intermediate =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      // Unwrap the callee chain: it.each([…])('title', fn) nests the real
      // argument list on the OUTER call, with callee `it.each([…])`.
      let callee = node.expression
      while (ts.isCallExpression(callee)) callee = callee.expression
      if (ts.isPropertyAccessExpression(callee)) callee = callee.expression
      if (intermediate) callee = null
      if (callee && ts.isIdentifier(callee)) {
        const name = callee.text
        if (name === 'describe') {
          const title = node.arguments.length > 0 ? titleFromArg(node.arguments[0], ts, fileName, source) : null
          const nested = title === null ? prefix : prefix === '' ? title : `${prefix} › ${title}`
          ts.forEachChild(node, (child) => visit(child, nested))
          return
        }
        if ((name === 'it' || name === 'test') && node.arguments.length > 0) {
          const title = titleFromArg(node.arguments[0], ts, fileName, source)
          titles.push(prefix === '' ? title : `${prefix} › ${title}`)
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, prefix))
  }
  visit(source, '')
  return titles
}

// "Added" is head titles minus base titles; a renamed test counts as added.
export function addedTestTitles(baseSource, headSource, fileName, ts) {
  const base = new Set(testTitles(baseSource, fileName, ts))
  return testTitles(headSource, fileName, ts).filter((title) => !base.has(title))
}

// No counts in the block: counts are the most common stale fact in the R10
// sample, and a reader can count lines.
export function renderBlock({ head, tests, trailers }) {
  const lines = [beginMarker(head), '', `Head: \`${head}\``, '']
  lines.push('### Tests added', '')
  if (tests.length === 0) {
    lines.push('(none)')
  } else {
    for (const { file, titles } of tests) {
      lines.push(`- \`${file}\``)
      for (const title of titles) lines.push(`  - ${title}`)
    }
  }
  lines.push('', '### Untested and why', '')
  if (trailers.length === 0) {
    lines.push('(none)')
  } else {
    for (const { file, reason } of trailers) lines.push(`- \`Untested: ${file} — ${reason}\``)
  }
  lines.push('', BLOCK_END)
  return lines.join('\n')
}

// Extracts the marked block, markers included. null when absent; throws on two
// begin markers — a body that has been spliced twice is ambiguous, never
// guessed at.
export function extractBlock(body) {
  const first = body.indexOf(BLOCK_BEGIN_PREFIX)
  if (first === -1) return null
  if (body.indexOf(BLOCK_BEGIN_PREFIX, first + 1) !== -1) {
    throw new Error('pr-facts: the body has two pr-facts:begin markers — remove one by hand; the tool never guesses')
  }
  const end = body.indexOf(BLOCK_END, first)
  if (end === -1) {
    throw new Error('pr-facts: the body has a pr-facts:begin marker with no pr-facts:end — repair or remove it by hand')
  }
  return { start: first, end: end + BLOCK_END.length, text: body.slice(first, end + BLOCK_END.length) }
}

// Replaces the block between the markers and nothing else; appends when absent.
export function spliceBlock(body, block) {
  const existing = extractBlock(body)
  if (existing === null) return `${body.replace(/\s*$/, '')}\n\n${block}\n`
  return body.slice(0, existing.start) + block + body.slice(existing.end)
}

// null when the body's block equals a fresh computation, else the first
// differing line. A missing block differs from line one.
export function blockDiff(body, block) {
  const existing = extractBlock(body)
  if (existing === null) return block.split('\n')[0]
  const a = existing.text.split('\n')
  const b = block.split('\n')
  // The returned line is always from the FRESH block — what the body should
  // say. Both blocks end with the END marker, so a length-only difference
  // still surfaces at a defined b[i] (the marker at the latest).
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return b[i]
  }
  return null
}

// The git wiring the bin needs, kept here so the bin stays argv+I/O. Base
// source reads as empty when the file is new.
export function gitShow(ref, path, cwd) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}

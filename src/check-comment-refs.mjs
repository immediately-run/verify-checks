import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import fastGlob from 'fast-glob'
import { fingerprint, ratchet, readBaseline } from './baseline.mjs'

// check-comment-refs — a backticked span in a comment that names a symbol or
// path must name one that EXISTS (R3-1085; implementation_standards R7's
// mechanical half: "the next reader trusts it", and the next reader is
// usually an agent taking the comment as instruction).
//
// Comments are found by the TypeScript SCANNER, not a regex over source
// (R12): ts.createScanner with skipTrivia:false yields the comment trivia
// ranges, and the same pass collects every Identifier token's text into the
// repo's identifier set — one pass per file. The scanner is resolved from the
// TARGET repo (createRequire on cwd's package.json), never from this
// package's own node_modules. Matching backticks INSIDE comment text is prose
// matching, which R12 does not govern.
//
// A backticked span is a reference when it matches one of three shapes:
//   path:       contains '/' and ends in a source/doc extension — resolves if
//               the file exists relative to the repo root or the commenting
//               file's directory
//   member:     a.b(.c)* — only the LAST segment is checked
//   identifier: length ≥ 4, camelCase/PascalCase (an internal lower→upper
//               transition) or SCREAMING_SNAKE with '_' — resolves if it is
//               in the scanned identifier set
// Everything else (`true`, `rw`, `{ ok: false }`, shell commands) is not a
// reference: the false-positive rate is what decides whether agents trust the
// check, and those shapes are rarely symbols. External names a comment
// legitimately cites but the code never spells go in the consumer's `allow`
// map ({ name: reason }); a stale allow entry — one no comment cites — is
// itself a finding, as in check-tokens.
//
// Fingerprints are `${file}|${span}` through fingerprint() — no line number,
// so moving a stale comment does not change its identity — ratcheted against
// the consumer's verify-baselines/comment-refs.json, which only shrinks.

const PATH_SPAN = /\.(ts|tsx|mjs|mts|js|json|css|mdx|md)$/
const IDENTIFIER_SPAN = /^[A-Za-z_$][\w$]*(\(\))?$/
const MEMBER_SPAN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+(\(\))?$/
const CAMEL_OR_PASCAL = /[a-z][A-Z]/
const SCREAMING_SNAKE = /^[A-Z0-9_]*_[A-Z0-9_]*$/
const BACKTICK_SPAN = /`([^`\n]+)`/g

function validateAllow(allow) {
  if (allow === undefined || allow === null) return {}
  if (typeof allow !== 'object' || Array.isArray(allow)) {
    throw new Error('check-comment-refs: allow must be a map from reference name to reason')
  }
  for (const [name, reason] of Object.entries(allow)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`check-comment-refs: allow entry ${name} needs a non-empty reason string`)
    }
  }
  return allow
}

/**
 * The scanner-provider chain, exported for tests: the target repo's
 * `typescript` first, then its `typescript-ast` alias (TS 7 ships no JS
 * scanner API), then this package's own alias. Each loader returns the
 * module or null.
 */
export function scannerLoaders(cwd) {
  const req = createRequire(join(cwd, 'package.json'))
  const tryLoad = (name, loader) => () => {
    try {
      const mod = loader(name)
      return typeof mod.createScanner === 'function' ? mod : null
    } catch {
      return null
    }
  }
  return [
    tryLoad('typescript', req),
    tryLoad('typescript-ast', req),
    tryLoad('typescript-ast', createRequire(import.meta.url)),
  ]
}

export function resolveScanner(loaders) {
  for (const load of loaders) {
    const mod = load()
    if (mod) return mod
  }
  throw new Error('check-comment-refs: no TypeScript scanner API found (the target repo’s typescript is TS 7 and no typescript-ast alias resolves)')
}

/** The identifier predicate: length ≥ 4, camelCase/PascalCase (an internal
 *  lower→upper transition) or SCREAMING_SNAKE with '_'. */
function isIdentifierShaped(name) {
  return name.length >= 4 && (CAMEL_OR_PASCAL.test(name) || SCREAMING_SNAKE.test(name))
}

/** The span's checked name and kind, or null when the span is not a reference. */
export function classifySpan(span) {
  // A path span with a glob/template placeholder (`connectors/*/x.test.ts`,
  // `config.<host>.json`) names a PATTERN, not a file, and one with
  // whitespace (`node scripts/check-lock-version.mjs`) is a shell command —
  // never a reference (the site-main wiring sample, R3-1085 exit
  // criterion 4; the whitespace class is review round 1).
  if (span.includes('/') && PATH_SPAN.test(span) && !/[*<>{}\s]/.test(span)) return { kind: 'path', name: span }
  if (MEMBER_SPAN.test(span)) {
    // Only the last segment is checked, and only when it is identifier-shaped:
    // without the predicate, `package.json` / `README.md` / `www.example.com`
    // classify as members whose checked name is the extension or TLD, and the
    // verdict carries no information about the named file (review round 1).
    const segments = span.replace(/\(\)$/, '').split('.')
    const last = segments[segments.length - 1]
    if (isIdentifierShaped(last)) return { kind: 'identifier', name: last }
    return null
  }
  if (IDENTIFIER_SPAN.test(span)) {
    const name = span.replace(/\(\)$/, '')
    if (isIdentifierShaped(name)) return { kind: 'identifier', name }
  }
  return null
}

/** One pass over `text`: the comment ranges and the code's identifier set.
 *
 *  COMMENTS come from the TypeScript SCANNER (skipTrivia: false) with the
 *  parser's half of the template-literal protocol reimplemented: a bare
 *  scan() desynchronizes on a template WITH a substitution, because only
 *  the parser knows a `}` ends a substitution and calls
 *  reScanTemplateToken — without it, comments after such a template are
 *  silently skipped (round 1, blocking; templateLiteral.ts). The
 *  substitution-brace stack below is that protocol. (The parse tree's
 *  getLeading/TrailingCommentRanges is NOT an alternative: it misses
 *  inline `/* … *\/` between tokens, post-comma comments, and JSX
 *  expression-container comments — round 2 and round 3, both blocking;
 *  templateLiteral.tsx and inlineComment.ts.)
 *
 *  IDENTIFIERS come from the AST walk (ts.isIdentifier), so property names
 *  the scanner emits as contextual-keyword kinds (`batch.set`'s `set`)
 *  count — the identifier set is what member citations resolve against.
 *
 *  String literals are never comments, and an identifier spelled only
 *  inside a comment never lands in the set. One residual hole, accepted:
 *  a regex literal whose body contains a comment opener (`/*`, `//`) is
 *  scanned as division tokens without the parser's reScanSlashToken, so a
 *  comment-looking span inside a regex could read as a comment — no
 *  consumer repo carries one today; a finding from one is the tell. */
export function scanFile(ts, text, { scriptKind } = {}) {
  const kind = scriptKind ?? ts.ScriptKind.TS
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  )
  const comments = []
  const templateStack = [] // one entry per open template literal: the brace depth of its current substitution
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() })
    } else if (token === ts.SyntaxKind.TemplateHead) {
      templateStack.push(0)
    } else if (token === ts.SyntaxKind.OpenBraceToken && templateStack.length > 0) {
      templateStack[templateStack.length - 1] += 1
    } else if (token === ts.SyntaxKind.CloseBraceToken && templateStack.length > 0) {
      if (templateStack[templateStack.length - 1] > 0) {
        templateStack[templateStack.length - 1] -= 1
      } else {
        // The `}` closes the template's substitution: re-scan it as the
        // template's continuation. TemplateMiddle opens the next
        // substitution (the frame stays); TemplateTail ends the literal.
        token = scanner.reScanTemplateToken()
        if (token === ts.SyntaxKind.TemplateTail) templateStack.pop()
        token = scanner.scan()
        continue
      }
    }
    token = scanner.scan()
  }

  const identifiers = new Set()
  const sf = ts.createSourceFile('scanned', text, ts.ScriptTarget.Latest, true, kind)
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return { comments, identifiers }
}

const SCRIPT_KIND_BY_EXTENSION = { '.tsx': 'TSX', '.jsx': 'JSX', '.mjs': 'JS', '.js': 'JS', '.cjs': 'JS' }

function scriptKindOf(ts, file) {
  const ext = Object.keys(SCRIPT_KIND_BY_EXTENSION).find((e) => file.endsWith(e))
  return ts.ScriptKind[SCRIPT_KIND_BY_EXTENSION[ext] ?? 'TS']
}

function lineOf(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line += 1
  return line
}

/**
 * The unresolved references in the matched files.
 * → { findings: [{ file, line, span, kind, fingerprint }], scannedFiles, commentCount }
 * `file` is cwd-relative; `fingerprint` is `${file}|${span}` through fingerprint().
 */
export function findCommentRefFindings({ patterns, ignore = [], allow, pathRoots = [], cwd = process.cwd() } = {}) {
  if (!patterns || patterns.length === 0) {
    throw new Error('check-comment-refs: patterns is required (e.g. ["src/**/*.{ts,tsx}"])')
  }
  const allowed = validateAllow(allow)
  // The scanner is the TARGET repo's TypeScript, never this package's own —
  // with one carve-out: TypeScript 7 (the native port) ships no JS scanner
  // API, so a repo whose `typescript` is v7 (this one) falls back to its
  // `typescript-ast` alias (npm:typescript@^5), which is the same v5 API.
  const ts = resolveScanner(scannerLoaders(cwd))
  const files = fastGlob.sync(patterns, { cwd, ignore })
  if (files.length === 0) {
    throw new Error(`check-comment-refs: patterns matched zero files (globs: ${patterns.join(', ')}; cwd ${cwd})`)
  }

  const identifiers = new Set()
  const perFile = []
  let commentCount = 0
  for (const file of files) {
    const text = readFileSync(resolve(cwd, file), 'utf8')
    const scanned = scanFile(ts, text, { scriptKind: scriptKindOf(ts, file) })
    for (const id of scanned.identifiers) identifiers.add(id)
    commentCount += scanned.comments.length
    perFile.push({ file, text, comments: scanned.comments })
  }

  const findings = []
  const cited = new Set()
  for (const { file, text, comments } of perFile) {
    for (const { start, end } of comments) {
      const commentText = text.slice(start, end)
      for (const match of commentText.matchAll(BACKTICK_SPAN)) {
        const span = match[1]
        const ref = classifySpan(span)
        if (!ref) continue
        cited.add(ref.name)
        const resolved =
          ref.kind === 'path'
            ? // Repo-relative, commenting-file-relative, then the consumer's
              // pathRoots (e.g. ['src'] — these repos' comments cite
              // src-relative paths, writing trust/refloor.ts for the file
              // under src/; review of the site-main wiring sample, R3-1085
              // exit criterion 4). An absolute span never resolves against
              // the HOST filesystem, or a baseline seeded on one machine
              // flips on another (round 1).
              !isAbsolute(span) &&
              (existsSync(resolve(cwd, span)) ||
                existsSync(resolve(dirname(resolve(cwd, file)), span)) ||
                pathRoots.some((root) => existsSync(resolve(cwd, root, span))))
            : identifiers.has(ref.name)
        // Object.hasOwn, never `in`: the allow map's prototype chain is not
        // an entry (`toString` in {} is true).
        if (!resolved && !Object.hasOwn(allowed, ref.name)) {
          findings.push({
            file,
            line: lineOf(text, start + match.index),
            span,
            kind: ref.kind,
            fingerprint: fingerprint(`${file}|${span}`),
          })
        }
      }
    }
  }
  for (const name of Object.keys(allowed)) {
    if (!cited.has(name)) {
      findings.push({
        file: '(allow)',
        line: 0,
        span: name,
        kind: 'stale-allow',
        fingerprint: fingerprint(`stale-allow|${name}`),
      })
    }
  }
  return { findings, scannedFiles: files.length, commentCount }
}

export async function checkCommentRefs({ patterns, ignore, allow, baselinePath, cwd = process.cwd() } = {}) {
  if (!baselinePath) {
    throw new Error('check-comment-refs: baselinePath is required (e.g. "verify-baselines/comment-refs.json")')
  }
  const { findings, scannedFiles, commentCount } = findCommentRefFindings({ patterns, ignore, allow, cwd })
  const baseline = readBaseline(resolve(cwd, baselinePath)) ?? []
  const baselined = new Set(baseline)
  for (const f of findings) {
    if (baselined.has(f.fingerprint)) continue
    console.error(
      f.kind === 'stale-allow'
        ? `comment-refs: stale allow entry \`${f.span}\` — no comment cites it; delete it`
        : `comment-refs: ${f.file}:${f.line} \`${f.span}\` — no such ${f.kind} in the scanned set`,
    )
  }
  console.log(`comment-refs: ${scannedFiles} file(s), ${commentCount} comment(s), ${findings.length} unresolved reference(s)`)
  await ratchet({ check: 'comment-refs', findings: findings.map((f) => f.fingerprint), baselinePath, cwd })
}

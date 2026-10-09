import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifySpan, findCommentRefFindings, checkCommentRefs, resolveScanner } from '../src/check-comment-refs.mjs'
import { readBaseline } from '../src/baseline.mjs'

// R3-1085 — cases for src/check-comment-refs.mjs over the fixture project in
// test/fixtures/comment-refs/ (its src/ files carry the resolving and the
// failing halves; the comments there enumerate which is which).

const FIXTURE = join(__dirname, 'fixtures/comment-refs')
const PATTERNS = ['src/**/*.ts']
const ALLOW = { structuredClone: 'DOM global the fixture code never spells' }

const spanSet = (findings: { span: string }[]) => new Set(findings.map((f) => f.span))

describe('findCommentRefFindings over the fixture project', () => {
  const run = (allow: Record<string, string> = ALLOW) =>
    findCommentRefFindings({ patterns: PATTERNS, allow, cwd: FIXTURE })

  it('a comment naming an existing function passes, a renamed one is found', () => {
    const { findings } = run()
    expect(spanSet(findings)).toContain('deletedHelper')
    expect(spanSet(findings)).not.toContain('existingHelper')
  })

  it('an existing path passes, a missing path is found', () => {
    const { findings } = run()
    expect(spanSet(findings)).toContain('./missing-file.ts')
    expect(spanSet(findings)).not.toContain('./existing.ts')
  })

  it('glob and template path spans (`a/*/b.ts`, `config.<host>.json`) name patterns, not files', () => {
    expect(classifySpan('connectors/*/tokenIsolation.test.ts')).toBeNull()
    expect(classifySpan('public/tinkerable.config.<host>.json')).toBeNull()
    expect(classifySpan('scripts/*.test.mjs')).toBeNull() // the sample's real instance: site-main scripts/check-test-roots.mjs
    expect(classifySpan('./missing-file.ts')).toEqual({ kind: 'path', name: './missing-file.ts' })
  })

  it('a shell-command span (`node scripts/x.mjs`) is not a path reference', () => {
    expect(classifySpan('node scripts/check-lock-version.mjs')).toBeNull()
  })

  it('a template literal with a substitution neither hides a comment nor mints identifiers', () => {
    // test/fixtures/comment-refs/src/templateLiteral.ts — the round-1
    // blocking regression: the bare scanner pass skipped the comment and
    // minted `deletedHelper` as a code identifier.
    const { findings } = run()
    const inFixture = findings.filter((f) => f.file.endsWith('templateLiteral.ts'))
    expect(inFixture.map((f) => f.span)).toEqual(['deletedHelper'])
  })

  it('`true`, `rw` and `{ ok: false }` are not references', () => {
    expect(classifySpan('true')).toBeNull()
    expect(classifySpan('rw')).toBeNull()
    expect(classifySpan('{ ok: false }')).toBeNull()
  })

  it('filename- and host-shaped spans (`package.json`, `README.md`, `www.example.com`) are not members', () => {
    expect(classifySpan('package.json')).toBeNull()
    expect(classifySpan('README.md')).toBeNull()
    expect(classifySpan('www.example.com')).toBeNull()
    expect(classifySpan('obj.missingMember()')).toEqual({ kind: 'identifier', name: 'missingMember' })
  })

  it('an empty allow map does not auto-allow prototype names (`toString`)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-refs-proto-'))
    try {
      writeFileSync(join(dir, 'a.ts'), '// calls `toString` here\nexport const x = 1\n')
      const { findings } = findCommentRefFindings({ patterns: ['*.ts'], cwd: dir })
      expect(spanSet(findings)).toContain('toString')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an absolute span never resolves against the host filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-refs-abs-'))
    try {
      const hostFile = join(dir, 'host.ts')
      writeFileSync(hostFile, 'export const y = 1\n')
      writeFileSync(join(dir, 'a.ts'), `// reads \`${hostFile}\` for it\nexport const x = 1\n`)
      const { findings } = findCommentRefFindings({ patterns: ['a.ts'], cwd: dir })
      expect(spanSet(findings)).toContain(hostFile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('`obj.missingMember()` checks only `missingMember`', () => {
    const { findings } = run()
    expect(spanSet(findings)).toContain('obj.missingMember()')
    expect(spanSet(findings)).not.toContain('obj.existingHelper()')
  })

  it('an identifier spelled only inside another comment does not resolve', () => {
    expect(spanSet(run().findings)).toContain('commentOnlyName')
  })

  it('a string literal containing a backtick span is not a comment', () => {
    expect(spanSet(run().findings)).not.toContain('phantomRef')
  })

  it('an allow entry silences its citation, and an unused allow entry is found', () => {
    const withStale = { ...ALLOW, unusedAllowName: 'nothing cites this' }
    const { findings } = run(withStale)
    const stale = findings.filter((f) => f.kind === 'stale-allow')
    expect(stale.map((f) => f.span)).toEqual(['unusedAllowName'])
    // …and the cited allow entry is neither a finding nor stale.
    expect(spanSet(findings)).not.toContain('structuredClone')
  })

  it('moving a comment ten lines leaves the fingerprint unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-refs-'))
    try {
      const body = (padding: string) => `${padding}// calls \`deletedHelper\` here\nexport const x = 1\n`
      const target = join(dir, 'a.ts')
      writeFileSync(target, body(''))
      const before = findCommentRefFindings({ patterns: ['*.ts'], cwd: dir }).findings
      writeFileSync(target, body('\n'.repeat(10)))
      const after = findCommentRefFindings({ patterns: ['*.ts'], cwd: dir }).findings
      expect(after.map((f) => f.fingerprint)).toEqual(before.map((f) => f.fingerprint))
      expect(before[0]?.line).toBe(1)
      expect(after[0]?.line).toBe(11)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('input validation and the ratchet wrapper', () => {
  it('rejects a missing patterns, a non-map allow, and a reasonless allow entry', () => {
    expect(() => findCommentRefFindings({ cwd: FIXTURE })).toThrow('patterns is required')
    expect(() => findCommentRefFindings({ patterns: PATTERNS, allow: ['x'] as never, cwd: FIXTURE })).toThrow(
      'allow must be a map',
    )
    expect(() => findCommentRefFindings({ patterns: PATTERNS, allow: { x: '' }, cwd: FIXTURE })).toThrow(
      'needs a non-empty reason',
    )
  })

  it('resolveScanner throws when no loader yields a scanner API', () => {
    expect(() => resolveScanner([() => null, () => null])).toThrow('no TypeScript scanner API found')
    expect(resolveScanner([() => null, () => ({ createScanner: () => {} })])).toBeTruthy()
  })

  it('throws when the patterns match zero files', () => {
    expect(() => findCommentRefFindings({ patterns: ['no-such-dir/**/*.ts'], cwd: FIXTURE })).toThrow(
      'matched zero files',
    )
  })

  it('checkCommentRefs ratchets: a matching baseline passes, a missing one fails loudly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-refs-gate-'))
    const prevCode = process.exitCode
    try {
      writeFileSync(join(dir, 'a.ts'), '// calls `deletedHelper` here\nexport const x = 1\n')
      await expect(checkCommentRefs({ patterns: ['*.ts'], cwd: dir })).rejects.toThrow('baselinePath is required')

      // First run without a baseline: the new finding is named, exit code 1.
      process.exitCode = 0
      await checkCommentRefs({ patterns: ['*.ts'], baselinePath: 'baseline.json', cwd: dir })
      expect(process.exitCode).toBe(1)

      // Commit the baseline for exactly those findings: the same run passes.
      const { findings } = findCommentRefFindings({ patterns: ['*.ts'], cwd: dir })
      writeFileSync(join(dir, 'baseline.json'), JSON.stringify(findings.map((f) => f.fingerprint)))
      process.exitCode = 0
      await checkCommentRefs({ patterns: ['*.ts'], baselinePath: 'baseline.json', cwd: dir })
      expect(process.exitCode).toBe(0)

      // A stale-allow finding prints its own message and fails the same way.
      process.exitCode = 0
      await checkCommentRefs({ patterns: ['*.ts'], allow: { neverCited: 'x' }, baselinePath: 'baseline.json', cwd: dir })
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = prevCode
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the check over this repo’s own src/', () => {
  it('equals the committed baseline exactly', async () => {
    const repoRoot = join(__dirname, '..')
    const { ALLOW, PATTERNS: OWN_PATTERNS } = await import('../scripts/check-comment-refs.mjs')
    const { findings } = findCommentRefFindings({
      patterns: OWN_PATTERNS,
      allow: ALLOW,
      cwd: repoRoot,
    })
    const baseline = readBaseline(join(repoRoot, 'verify-baselines/comment-refs.json')) ?? []
    expect([...new Set(findings.map((f) => f.fingerprint))].sort()).toEqual([...baseline].sort())
  })
})

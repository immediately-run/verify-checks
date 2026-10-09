import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// typescript-ast is the npm alias for typescript@5: this repo's own
// `typescript` is 7 native, which exposes no createSourceFile, while every
// repo pr-facts runs in carries the classic 5.x API the tests exercise.
import * as ts from 'typescript-ast'
import {
  BLOCK_END,
  addedTestTitles,
  beginMarker,
  blockDiff,
  renderBlock,
  spliceBlock,
} from '../src/pr-facts.mjs'

// R3-1080. The one real-file case reads THIS repo's baseline.test.ts: a
// hand-written fixture would assert my belief about what a test file looks
// like; the repo's own file is the shape the tool actually runs over.
const REPO_ROOT = new URL('..', import.meta.url).pathname
const REAL_TEST = readFileSync(join(REPO_ROOT, 'test/baseline.test.ts'), 'utf8')

describe('addedTestTitles', () => {
  it('returns exactly the removed title when the base is the real file minus one it', () => {
    // The `it` is removed AST-precisely: cutting a text line would break the
    // parse and assert nothing about the diff.
    const source = ts.createSourceFile('test/baseline.test.ts', REAL_TEST, ts.ScriptTarget.Latest, true)
    let removed: { title: string; start: number; end: number } | undefined
    const find = (node: import('typescript-ast').Node) => {
      if (
        !removed &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'it' &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        removed = { title: node.arguments[0].text, start: node.getStart(source), end: node.getEnd() }
      }
      ts.forEachChild(node, find)
    }
    find(source)
    expect(removed).toBeDefined()
    const base = REAL_TEST.slice(0, removed!.start) + REAL_TEST.slice(removed!.end)
    const added = addedTestTitles(base, REAL_TEST, 'test/baseline.test.ts', ts)
    // Exactly the removed title — joined with its describe prefix per the
    // nesting rule, so the assertion is on the suffix.
    expect(added.length).toBe(1)
    expect(added[0].endsWith(removed!.title)).toBe(true)
  })

  it('joins nested describe titles with ›', () => {
    const source = `describe('outer', () => { describe('inner', () => { it('works', () => {}) }) })`
    expect(addedTestTitles('', source, 'x.test.ts', ts)).toEqual(['outer › inner › works'])
  })

  it('renders it.each and non-literal titles as the dynamic marker with the line', () => {
    const source = `it.each([1, 2])('case %s', () => {})\nit(\`templated \${x}\`, () => {})`
    const titles = addedTestTitles('', source, 'x.test.ts', ts)
    expect(titles).toEqual(['case %s', '<dynamic title> (x.test.ts:2)'])
  })

  it('returns every title for a new file (empty base)', () => {
    const source = `describe('a', () => { it('one', () => {}); test('two', () => {}) })`
    expect(addedTestTitles('', source, 'x.test.ts', ts)).toEqual(['a › one', 'a › two'])
  })

  it('counts a renamed test as added', () => {
    expect(addedTestTitles(`it('old', () => {})`, `it('new', () => {})`, 'x.test.ts', ts)).toEqual(['new'])
  })
})

const BLOCK = renderBlock({
  head: 'abc123',
  tests: [{ file: 'x.test.ts', titles: ['a › one'] }],
  trailers: [{ file: 'src/y.ts', reason: 'covered by the integration suite' }],
})

describe('spliceBlock', () => {
  it('appends when the body has no block', () => {
    const out = spliceBlock('## What\n', BLOCK)
    expect(out).toBe(`## What\n\n${BLOCK}\n`)
  })

  it('replaces only between the markers, leaving the bytes outside equal', () => {
    const body = `before\n${BLOCK}\nafter\n`
    const next = renderBlock({ head: 'def456', tests: [], trailers: [] })
    const out = spliceBlock(body, next)
    expect(out.startsWith('before\n')).toBe(true)
    expect(out.endsWith('\nafter\n')).toBe(true)
    expect(out).toContain(beginMarker('def456'))
    expect(out).not.toContain('abc123')
  })

  it('throws on two begin markers', () => {
    expect(() => spliceBlock(`${BLOCK}\n${BLOCK}`, BLOCK)).toThrow(/two pr-facts:begin markers/)
  })
})

describe('blockDiff', () => {
  it('returns null when the block equals a fresh computation', () => {
    expect(blockDiff(`intro\n${BLOCK}\noutro`, BLOCK)).toBeNull()
  })

  it('returns the first differing line when the head SHA moved', () => {
    const stale = renderBlock({ head: '000000', tests: [{ file: 'x.test.ts', titles: ['a › one'] }], trailers: [{ file: 'src/y.ts', reason: 'covered by the integration suite' }] })
    expect(blockDiff(`intro\n${stale}\noutro`, BLOCK)).toBe(beginMarker('abc123'))
  })

  it('returns the first block line when the body has no block', () => {
    expect(blockDiff('no block here', BLOCK)).toBe(beginMarker('abc123'))
  })
})

describe('renderBlock', () => {
  it('carries the head, the titles, and the trailer verbatim, with no counts', () => {
    expect(BLOCK).toContain(beginMarker('abc123'))
    expect(BLOCK).toContain('- `x.test.ts`\n  - a › one')
    expect(BLOCK).toContain('- `Untested: src/y.ts — covered by the integration suite`')
    expect(BLOCK.endsWith(BLOCK_END)).toBe(true)
    expect(BLOCK).not.toMatch(/\d+ tests? added/i)
  })
})

// The trailer leg reuses commitTrailers, so it adds no second parser — this
// case runs the BIN against a temp git repo with an Untested: trailer and
// asserts the line appears verbatim.
describe('the bin against a temp git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-facts-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('prints the Untested: trailer verbatim', () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    git(['add', 'a.ts'])
    git(['commit', '-q', '-m', 'base'])
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
    git(['add', 'b.ts'])
    git(['commit', '-q', '-m', 'work\n\nUntested: src/b.ts — covered by the integration suite'])
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin/pr-facts.mjs')], { cwd: dir, encoding: 'utf8' })
    expect(out).toContain('- `Untested: src/b.ts — covered by the integration suite`')
  })
})

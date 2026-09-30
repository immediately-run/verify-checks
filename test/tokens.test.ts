import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkTokens, findTokenFindings, loadTokenInputs } from '../src/check-tokens.mjs'

// Fixture-driven, consumer-shaped on purpose: cssGlobs ['src/**/*.css'] and
// sourceGlobs ['src/**/*.{ts,tsx}'] with cwd set to the fixture root — passing
// a directory path instead of globs is exactly how R3-674 scanned zero files
// and passed for weeks.
const FIXTURES = new URL('./fixtures/tokens/', import.meta.url).pathname

function findingsFor(fixture: string, { allow }: { allow?: Record<string, string> } = {}) {
  const cwd = join(FIXTURES, fixture)
  const inputs = loadTokenInputs({ cssGlobs: ['src/**/*.css'], sourceGlobs: ['src/**/*.{ts,tsx}'], cwd })
  return findTokenFindings({ ...inputs, allow })
}

describe('check-tokens over fixtures (consumer-shaped globs)', () => {
  it('a planted undeclared var(--nope) is one undeclared finding', () => {
    expect(findingsFor('undeclared')).toEqual(['undeclared|src/styles.css|--nope'])
  })

  it('a fallback does not excuse an undeclared name, and is not a literal', () => {
    // var(--nope, #fff): still one undeclared finding, and the #fff inside the
    // fallback is NOT a separate literal finding.
    expect(findingsFor('fallback-no-excuse')).toEqual(['undeclared|src/styles.css|--nope'])
  })

  it('a declared token used through var() is no finding', () => {
    expect(findingsFor('token-declaration')).toEqual([])
  })

  it('colour literals in ordinary declarations are one finding each', () => {
    expect(findingsFor('literals')).toEqual([
      'literal|src/styles.css|.one|color|#f0f',
      'literal|src/styles.css|.three|color|rebeccapurple',
      'literal|src/styles.css|.two|color|rgb(0 0 0)',
    ])
  })

  it('transparent, currentColor, inherit and none are not literals', () => {
    expect(findingsFor('keyword-exclusions')).toEqual([])
  })

  it('color-mix() is not a literal in itself, but its arguments are judged', () => {
    expect(findingsFor('color-mix')).toEqual(['literal|src/styles.css|.blend|color|#fff'])
  })

  it('a nested @media rule carries the prelude in the selector', () => {
    expect(findingsFor('media-prelude')).toEqual([
      'literal|src/styles.css|@media (max-width: 900px) > .narrow|color|#123456',
    ])
  })

  it("a 'var(--ghost)' string in a .tsx is an undeclared finding (the lexical scan sees comments and strings too)", () => {
    expect(findingsFor('tsx-reference')).toEqual(['undeclared|src/app.tsx|--ghost'])
  })
})

describe('check-tokens allow entries', () => {
  it('an allow entry without a reason throws at load', () => {
    expect(() => findingsFor('token-declaration', { allow: { '--runtime-x': '' } })).toThrow(
      /--runtime-x needs a non-empty reason/,
    )
  })

  it('an allow entry that CSS also declares is a stale-allow finding', () => {
    expect(findingsFor('token-declaration', { allow: { '--brand': 'set at runtime' } })).toEqual([
      'stale-allow|--brand',
    ])
  })

  it('an allow entry nothing references is a stale-allow finding', () => {
    expect(findingsFor('token-declaration', { allow: { '--never-used': 'legacy' } })).toEqual([
      'stale-allow|--never-used',
    ])
  })

  it('an allowed name that is referenced but undeclared is no finding', () => {
    expect(findingsFor('undeclared', { allow: { '--nope': 'set at runtime by the host' } })).toEqual([])
  })
})

describe('check-tokens is non-vacuous by construction', () => {
  it('throws, naming the globs, when cssGlobs match zero files', () => {
    const cwd = join(FIXTURES, 'empty')
    expect(() => loadTokenInputs({ cssGlobs: ['src/**/*.css'], cwd })).toThrow(/src\/\*\*\/\*\.css/)
  })

  it('throws when zero custom properties are declared', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'check-tokens-'))
    try {
      writeFileSync(join(cwd, 'plain.css'), '.a { color: var(--x); }\n')
      await expect(
        checkTokens({ cssGlobs: ['*.css'], baselinePath: 'baseline.json', cwd }),
      ).rejects.toThrow(/zero custom properties declared/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('throws when zero var() references are found', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'check-tokens-'))
    try {
      writeFileSync(join(cwd, 'plain.css'), ':root { --x: #fff; }\n')
      await expect(
        checkTokens({ cssGlobs: ['*.css'], baselinePath: 'baseline.json', cwd }),
      ).rejects.toThrow(/zero var\(\) references/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('checkTokens against the ratchet', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('a baseline matching the findings passes; a missing finding fails loudly', async () => {
    const cwd = join(FIXTURES, 'consumer')
    const expected = findingsFor('consumer')
    expect(expected).toEqual(['literal|src/styles.css|.legacy|color|#abcdef'])

    const tmp = mkdtempSync(join(tmpdir(), 'check-tokens-'))
    try {
      const baselinePath = join(tmp, 'tokens.json')
      writeFileSync(baselinePath, `${JSON.stringify(expected, null, 2)}\n`)
      await checkTokens({
        cssGlobs: ['src/**/*.css'],
        sourceGlobs: ['src/**/*.{ts,tsx}'],
        baselinePath,
        cwd,
      })
      expect(process.exitCode).toBeUndefined()

      writeFileSync(baselinePath, `${JSON.stringify([], null, 2)}\n`)
      await checkTokens({
        cssGlobs: ['src/**/*.css'],
        sourceGlobs: ['src/**/*.{ts,tsx}'],
        baselinePath,
        cwd,
      })
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = undefined
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

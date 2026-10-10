import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { typeAwareRules } from '../src/eslint-type-aware.mjs'

// R3-1081 — the shared type-aware rule set, driven over the fixture project by
// the REAL producer (ESLint 9 + typescript-eslint, both devDependencies here).
// Each case asserts one rule's verdict on one fixture file.

const FIXTURE = join(__dirname, 'fixtures/type-aware')

async function lintFile(name: string) {
  const { ESLint } = await import('eslint')
  const ts = await import('typescript-eslint')
  const engine = new ESLint({
    cwd: FIXTURE,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['src/**/*.ts'],
        languageOptions: {
          parser: ts.parser,
          parserOptions: { projectService: true, tsconfigRootDir: FIXTURE },
        },
        plugins: { '@typescript-eslint': ts.plugin },
        rules: typeAwareRules,
      },
    ],
  })
  const [result] = await engine.lintFiles([join('src', name)])
  return result.messages.map((m) => m.ruleId)
}

describe('typeAwareRules', () => {
  it('a bare fetchThing() is found; void fetchThing() is not', async () => {
    expect(await lintFile('floating.ts')).toContain('@typescript-eslint/no-floating-promises')
    expect(await lintFile('voided.ts')).toEqual([])
  })

  it('forEach(async …) is found', async () => {
    expect(await lintFile('forEach.ts')).toContain('@typescript-eslint/no-misused-promises')
  })

  it("a switch over 'a'|'b' handling only 'a' is found; with default: it is not (R-SDKS-2)", async () => {
    expect(await lintFile('switchNoDefault.ts')).toContain('@typescript-eslint/switch-exhaustiveness-check')
    expect(await lintFile('switchDefault.ts')).toEqual([])
  })

  it('a switch on string without default is found', async () => {
    expect(await lintFile('switchString.ts')).toContain('@typescript-eslint/switch-exhaustiveness-check')
  })
})

#!/usr/bin/env node
// pr-facts (R3-1080) — argv parsing and I/O only; the logic is src/pr-facts.mjs.
//
//   pr-facts                      print the block for HEAD against origin/main
//   pr-facts --splice <body-file> replace (or append) the block in place
//   pr-facts --check  <body-file> exit 1, naming the first differing line, when
//                                 the body's block is missing or stale
//
// No network and no gh: the caller moves the body through
// `gh pr view --json body -q .body > body.md` and `gh pr edit --body-file`.

import { readFileSync, writeFileSync } from 'node:fs'
import { commitTrailers, mergeBase } from '../src/producers.mjs'
import {
  addedTestTitles,
  blockDiff,
  gitShow,
  loadTypescript,
  renderBlock,
  spliceBlock,
} from '../src/pr-facts.mjs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

function fail(message) {
  process.stderr.write(`pr-facts: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const mode = args[0] ?? ''
if (mode !== '--splice' && mode !== '--check' && mode !== '') {
  fail(`unknown arguments: ${args.join(' ')} (want: nothing, --splice <body-file>, or --check <body-file>)`)
}
if ((mode === '--splice' || mode === '--check') && args.length !== 2) {
  fail(`${mode} takes exactly one body-file argument`)
}

const cwd = process.cwd()
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const mb = mergeBase('origin/main', cwd)
const changed = execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRT', `${mb}..HEAD`], { cwd, encoding: 'utf8' })
  .split('\0')
  .map((line) => line.trim())
  .filter(Boolean)
const testFiles = changed.filter((path) => /\.(test|spec)\.[jt]sx?$/.test(path))

// typescript resolves from the target repo, and only when a test file changed:
// a PR that touches no tests must not demand the compiler be installed.
const ts = testFiles.length > 0 ? loadTypescript(cwd) : null
const tests = []
for (const file of testFiles) {
  const titles = addedTestTitles(gitShow(mb, file, cwd), readFileSync(join(cwd, file), 'utf8'), file, ts)
  if (titles.length > 0) tests.push({ file, titles })
}

const block = renderBlock({ head, tests, trailers: commitTrailers('origin/main', cwd) })

if (mode === '') {
  process.stdout.write(`${block}\n`)
} else {
  const body = readFileSync(args[1], 'utf8')
  if (mode === '--splice') {
    writeFileSync(args[1], spliceBlock(body, block))
  } else {
    const diff = blockDiff(body, block)
    if (diff !== null) {
      fail(`the body's pr-facts block is missing or stale — first differing line: ${diff}`)
    }
  }
}

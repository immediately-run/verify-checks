// check:untested — coverage mode for src/**, name mode for scripts/**
// (R3-580; docs/content/plans/untested-coverage). This repo self-hosts: the
// wrapper imports its own src/ directly (as check-publish-version.mjs does),
// so the gate runs the code in THIS commit, not the published package.
//
// scripts/** keeps the name check: vitest cannot instrument repo scripts.
// check-publish-version.mjs is self-testing via its --self-test leg (plan
// Q5's legitimate shape); the trailer mechanism is PER-COMMIT
// (commitTrailers reads merge-base..HEAD), so a PR touching a script carries
// the `Untested:` trailer on its own commit — as this one's commit does.
//
// The ratchet lives in verify-baselines/untested.json (seeded once with
// --write-baseline, shrunk by hand as gaps close — never regenerated).

import { execFileSync } from 'node:child_process'
import { checkUntested, checkUntestedCoverage } from '../src/check-untested.mjs'

execFileSync(
  process.execPath,
  [
    'node_modules/.bin/vitest',
    'run',
    '--coverage',
    '--coverage.reporter=json',
    '--coverage.all=true',
    '--coverage.include=src/**',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
)

await checkUntestedCoverage({
  base: 'origin/main',
  logicPaths: { include: ['src/**'] },
  coverageReportPath: 'coverage/coverage-final.json',
  baselinePath: 'verify-baselines/untested.json',
})

await checkUntested({
  base: 'origin/main',
  logicPaths: { include: ['scripts/**'] },
})

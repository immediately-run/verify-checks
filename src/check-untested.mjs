import { changedSince, commitTrailers, trackedTestFiles } from './producers.mjs'
import { untestedFiles } from './untested-core.mjs'

export { untestedFiles, matchesAny, hasSiblingTest, globToRegex, IS_TEST_FILE } from './untested-core.mjs'
// Coverage mode (R3-580): the opted-in successor to the name check below.
export {
  checkUntestedCoverage,
  uncoveredRangesByFile,
  unexcusedGaps,
  staleEntries,
  growthViolations,
  parseBaselineEntry,
  formatBaselineEntry,
} from './check-untested-coverage.mjs'
export { changedLineRanges, changedSince } from './producers.mjs'
export { readCoverageReport, readLcov, readIstanbulCoverage } from './coverage.mjs'

export async function checkUntested({
  base = 'origin/main',
  logicPaths,
  cwd = process.cwd(),
} = {}) {
  if (!logicPaths) {
    throw new Error('check-untested: logicPaths is required (e.g. { include: ["src/lib/**", "scripts/**"] })')
  }
  const changed = changedSince(base, cwd)
  const tests = trackedTestFiles(cwd)
  const trailers = commitTrailers(base, cwd)
  const { untested, declared } = untestedFiles({ changed, tests, trailers, logicPaths })
  for (const entry of declared) {
    console.log(`untested: ${entry.file} — declared: ${entry.reason}`)
  }
  if (untested.length > 0) {
    for (const file of untested) {
      console.error(`untested: ${file} — no sibling *.test.* and no "Untested:" trailer`)
    }
    console.error(`untested: ${untested.length} changed logic file(s) without a test or a declared reason`)
    process.exitCode = 1
  }
}

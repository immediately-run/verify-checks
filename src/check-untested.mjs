import { changedSince, commitTrailers, trackedTestFiles } from './producers.mjs'
import { untestedFiles } from './untested-core.mjs'

export { untestedFiles, matchesAny, hasSiblingTest, globToRegex } from './untested-core.mjs'

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

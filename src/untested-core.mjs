const GLOB_GROUP_OPEN = '\u0001'
const GLOB_GROUP_CLOSE = '\u0002'
const GLOB_ALT = '\u0003'
const GLOB_GLOBSTAR = '\u0004'
const GLOB_GLOBSTAR_SLASH = '\u0005'

export function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    // brace expansion, BEFORE * handling and with the braces themselves kept
    // out of the escape class: `*.{ts,tsx}` becomes `*.(ts|tsx)`. Without this
    // the braces were matched literally and a braced pattern silently matched
    // nothing (the R3-674 shape), found by the review gate on 2026-09-30.
    // The \u0001-\u0005 sentinels are control bytes no glob carries.
    .replace(/\{([^}]*)\}/g, (_, alts) => `${GLOB_GROUP_OPEN}${alts.replace(/,/g, GLOB_ALT)}${GLOB_GROUP_CLOSE}`)
    // `**/`, like fast-glob/minimatch, is zero-or-more DIRECTORIES — without
    // this, `src/**/*.{ts,tsx}` never matches `src/a.ts` (same gate, 2026-09-30).
    .replace(/\*\*\//g, GLOB_GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOB_GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(GLOB_GLOBSTAR_SLASH, '(?:.+/)?')
    .replaceAll(GLOB_GLOBSTAR, '.*')
    .replaceAll(GLOB_GROUP_OPEN, '(')
    .replaceAll(GLOB_ALT, '|')
    .replaceAll(GLOB_GROUP_CLOSE, ')')
  return new RegExp(`^${escaped}$`)
}

export function matchesAny(path, { include, exclude = [] }) {
  if (!include.some((pattern) => globToRegex(pattern).test(path))) return false
  return !exclude.some((pattern) => globToRegex(pattern).test(path))
}

const TEST_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']

export const IS_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

export function hasSiblingTest(file, testSet) {
  const dot = file.lastIndexOf('.')
  const stem = dot === -1 ? file : file.slice(0, dot)
  return TEST_EXTENSIONS.some((ext) => testSet.has(`${stem}.test.${ext}`) || testSet.has(`${stem}.spec.${ext}`))
}

// Pure decision: which changed files under the repo's logic paths are neither
// covered by a sibling test nor declared with an `Untested: <path> — <reason>`
// commit trailer. Test files themselves are the supply, not the demand — a
// co-located routes.test.ts is the sibling test, never a file that owes one.
// The git producers (changedSince, commitTrailers, trackedTestFiles in
// ./producers.mjs) feed it in production; the tests exercise both this
// function and those producers.
export function untestedFiles({ changed, tests, trailers = [], logicPaths }) {
  const testSet = new Set(tests)
  const trailerByFile = new Map(trailers.map((trailer) => [trailer.file, trailer.reason]))
  const untested = []
  const declared = []
  for (const file of changed) {
    if (IS_TEST_FILE.test(file)) continue
    if (!matchesAny(file, logicPaths)) continue
    const reason = trailerByFile.get(file)
    if (reason !== undefined) {
      declared.push({ file, reason })
      continue
    }
    if (hasSiblingTest(file, testSet)) continue
    untested.push(file)
  }
  untested.sort()
  declared.sort((a, b) => a.file.localeCompare(b.file))
  return { untested, declared }
}

export function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

export function matchesAny(path, { include, exclude = [] }) {
  if (!include.some((pattern) => globToRegex(pattern).test(path))) return false
  return !exclude.some((pattern) => globToRegex(pattern).test(path))
}

const TEST_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']

export function hasSiblingTest(file, testSet) {
  const dot = file.lastIndexOf('.')
  const stem = dot === -1 ? file : file.slice(0, dot)
  return TEST_EXTENSIONS.some((ext) => testSet.has(`${stem}.test.${ext}`) || testSet.has(`${stem}.spec.${ext}`))
}

// Pure decision: which changed files under the repo's logic paths are neither
// covered by a sibling test nor declared with an `Untested: <path> — <reason>`
// commit trailer. The git producers (changedSince, commitTrailers,
// trackedTestFiles in ./producers.mjs) feed it in production; the tests
// exercise both this function and those producers.
export function untestedFiles({ changed, tests, trailers = [], logicPaths }) {
  const testSet = new Set(tests)
  const trailerByFile = new Map(trailers.map((trailer) => [trailer.file, trailer.reason]))
  const untested = []
  const declared = []
  for (const file of changed) {
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

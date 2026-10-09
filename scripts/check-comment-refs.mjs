import { pathToFileURL } from 'node:url'
import { checkCommentRefs } from '../src/check-comment-refs.mjs'

// The allow entries are knip's JSON-reporter member names, cited by
// src/producers.mjs's class-exclusion comment but never spelled in this
// repo's code (they are knip's API surface, not ours). Exported so the
// own-src test asserts the baseline against THIS map, not a copy.
export const ALLOW = {
  devDependencies: 'knip JSON reporter class name, cited in src/producers.mjs',
  initRow: 'knip JSON reporter method, cited in src/producers.mjs',
  enumMembers: 'knip JSON reporter class name, cited in src/producers.mjs',
  namespaceMembers: 'knip JSON reporter class name, cited in src/producers.mjs',
  catalogReferences: 'knip JSON reporter class name, cited in src/producers.mjs',
  nsExports: 'knip JSON reporter class name, cited in src/producers.mjs',
  nsTypes: 'knip JSON reporter class name, cited in src/producers.mjs',
  optionalPeerDependencies: 'knip JSON reporter class name, cited in src/producers.mjs',
}

export const PATTERNS = ['src/**/*.mjs']

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkCommentRefs({
    patterns: PATTERNS,
    allow: ALLOW,
    baselinePath: 'verify-baselines/comment-refs.json',
  })
}

import { checkCommentRefs } from '../src/check-comment-refs.mjs'

await checkCommentRefs({
  patterns: ['src/**/*.mjs'],
  baselinePath: 'verify-baselines/comment-refs.json',
})

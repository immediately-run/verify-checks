import { ratchet } from './baseline.mjs'
import { assertFreshInstall } from './installFreshness.mjs'
import { knipFingerprints, runKnip } from './producers.mjs'

export { knipFingerprints, runKnip }

export async function checkUnused({ baselinePath, cwd = process.cwd() } = {}) {
  if (!baselinePath) {
    throw new Error('check-unused: baselinePath is required (e.g. "verify-baselines/unused.json")')
  }
  // knip resolves the module graph, so a stale install makes its silence meaningless
  // (R3-628). Refuse before producing a verdict the tree cannot support.
  assertFreshInstall({ cwd, check: 'unused' })
  const report = runKnip({ cwd })
  await ratchet({ check: 'unused', findings: knipFingerprints(report), baselinePath, cwd })
}

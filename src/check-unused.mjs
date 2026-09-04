import { ratchet } from './baseline.mjs'
import { knipFingerprints, runKnip } from './producers.mjs'

export { knipFingerprints, runKnip }

export async function checkUnused({ baselinePath, cwd = process.cwd() } = {}) {
  if (!baselinePath) {
    throw new Error('check-unused: baselinePath is required (e.g. "verify-baselines/unused.json")')
  }
  const report = runKnip({ cwd })
  await ratchet({ check: 'unused', findings: knipFingerprints(report), baselinePath, cwd })
}

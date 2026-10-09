// The fixture's resolving half: `existingHelper` is defined below, so a
// comment citing `existingHelper` or `obj.existingHelper()` resolves, and the
// path `./existing.ts` exists. `true`, `rw` and `{ ok: false }` are prose,
// not references. `structuredClone` is a DOM global the code never spells —
// the consumer's allow map carries it.
export function existingHelper(x: number): number {
  return x + 1
}

export const obj = { existingHelper }

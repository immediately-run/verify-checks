// Regression fixture for the round-1 blocking finding: a template literal
// WITH A SUBSTITUTION desynchronized the parser-free scanner pass, so the
// stale citation below was silently skipped (and phantom identifiers were
// minted). The real parse sees both comments, and the cited helper is still
// gone.
const a = `x${1}z`
// calls `deletedHelper` here
export const b = a

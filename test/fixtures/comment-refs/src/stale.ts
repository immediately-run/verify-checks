// The fixture's failing half:
// - `deletedHelper` was renamed away — no such identifier in the scanned set.
// - `./missing-file.ts` does not exist.
// - `obj.missingMember()` — only `missingMember` is checked, and it is gone.
// - `commentOnlyName` is spelled in THIS comment and nowhere in code — an
//   identifier spelled only inside a comment does not resolve.
// The string literal below mentions a phantom reference in backticks, but a
// string literal is not a comment, so that span is never a finding.
export const s = 'see `phantomRef` in the docs'

// Regression fixture for the round-3 blocking finding: the parse-tree trivia
// walk missed inline comments between tokens, post-comma comments, and
// comments in NON-empty JSX expression containers. The template-aware scanner
// sees all three; every cited name here is still gone.
const y = /* calls `goneInlineHelper` */ 1
foo(/* pre `gonePreComma` */ y, y) // trail `goneTrailing`
export const z = y

declare function foo(a: number, b: number): void

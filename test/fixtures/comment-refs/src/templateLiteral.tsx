// Regression fixture for the round-2 blocking finding: a comment inside an
// EMPTY JSX expression container {/* */} belongs to no expression child, so
// the leading/trailing-trivia walk never saw it. The container owns it now,
// and the cited helper is still gone.
export const C = () => <div>{/* inner `goneJsxFn` */}</div>
export const D = () => <div>{/* nonEmpty `goneJsxNonEmpty` */ 1}</div>

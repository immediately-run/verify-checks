// The clean half: every banned name sits in a position that BINDS or NAMES
// it — a variable declarator, a function name, a parameter, an import
// binding, a type name, an interface — never a use of the platform global.
// (Shadowing the global's name locally is legal; the check flags uses, and
// a use of a shadowing local is indistinguishable without scope analysis —
// so this fixture binds and never uses.)
const caches = new Map();
function localStorage() { return 1; }
const withParam = (indexedDB: unknown) => 1;
import { sessionStorage as aliased } from './aliases';
type localStorage = string;
interface cachesLike { size: number }
const shim = { localStorage: 'an object key names a property' };
const note = 'localStorage in a string is not a reference';
const Shadow = (props: { cachesLike: cachesLike }) => <div caches-like={props.cachesLike.size}>{note}{shim.localStorage}</div>;
void withParam; void aliased; void Shadow;
export default function App() { return <Shadow cachesLike={{ size: 1 }} />; }

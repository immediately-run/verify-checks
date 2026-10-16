// The clean half: the SDK's mounts instead of web storage, and every
// banned name either absent or in a declaring (non-referencing) position.
const storageShim = {
  // an object key names a property — not the global
  localStorage: 'shadowed-key',
};
export default function App() {
  void storageShim;
  // a string literal is not an identifier reference
  const kind = 'localStorage';
  void kind;
  return null;
}

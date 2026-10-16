// The violating half of the self-test pair: every shape here is a real
// identifier reference to a banned global.
export default function App() {
  const token = localStorage.getItem('token');
  window.sessionStorage.setItem('seen', '1');
  void caches.keys();
  void indexedDB.databases();
  return null;
}

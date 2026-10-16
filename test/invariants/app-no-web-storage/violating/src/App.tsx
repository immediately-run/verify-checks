// The violating half of the self-test pair: every real identifier reference
// to a banned global. The binding positions are the clean fixture's half.
export default function App() {
  const token = localStorage.getItem('token');
  window.sessionStorage.setItem('seen', '1');
  void caches.keys();
  void indexedDB.databases();
  return null;
}

// The clean half: the local-dev entry imports the DOM renderer, the app,
// and the SDK's narrow subpaths (the prescribed shape — R3-553).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from '@immediately-run/sdk/boot';
import App from './App';

boot({ children: <App />, mount: (children) => createRoot(document.getElementById('root')!).render(children) });
void StrictMode;

// The violating half: main.tsx reaches for both things that must stay out
// of the local dev entry — a CSS import and the SDK package ROOT (which
// reaches for the host transport at module load and throws under vite dev).
import { StrictMode } from 'react';
import './app.css';
import { openSettings } from '@immediately-run/sdk';
import App from './App';

export default function bootstrap() {
  void openSettings;
  return <StrictMode><App /></StrictMode>;
}

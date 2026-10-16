// The violating half: main.tsx reaches for both things that must stay in
// App.tsx — a CSS import and the SDK.
import { StrictMode } from 'react';
import './app.css';
import { openSettings } from '@immediately-run/sdk';
import App from './App';

export default function bootstrap() {
  void openSettings;
  return <StrictMode><App /></StrictMode>;
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-serif/500.css';
import '@fontsource/ibm-plex-serif/600.css';
import './styles/fonts.css';

// Production-only service worker (never registered in dev so HMR stays clean).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW unavailable — panel keeps working without it
    });
  });
}
import './styles/tokens.css';
import './styles/base.css';
import { App } from './App';
import { I18nProvider } from './i18n/I18nProvider.js';
import {
  initializePendingRemoteSession,
  scrubLegacyRemoteCredentials,
} from './api/remoteSession.js';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found');
}
const reactRoot = createRoot(rootElement);

async function boot(): Promise<void> {
  scrubLegacyRemoteCredentials();
  try {
    // Electron passes a remote bootstrap out-of-band. Complete the one-time
    // cookie exchange before any React child can issue an API request.
    await initializePendingRemoteSession();
  } catch {
    // Keep the UI available so the operator can retry manually in Settings;
    // never include bootstrap material in this diagnostic.
    console.error('[pihub] remote session bootstrap failed');
  }

  reactRoot.render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
}

void boot();

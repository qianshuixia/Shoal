import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './mobile/mobile.css';

const isMobileEntry =
  Boolean(document.querySelector('meta[name="shoal-mobile"][content="1"]')) ||
  new URLSearchParams(location.search).get('mobile') === '1';

const MobileApp = lazy(() => import('./mobile/MobileApp.tsx').then((m) => ({ default: m.MobileApp })));
const DesktopApp = lazy(() => import('./App.tsx').then((m) => ({ default: m.App })));
const RootApp = isMobileEntry ? MobileApp : DesktopApp;

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div style={{ padding: '1rem', color: '#7b7f88' }}>加载中…</div>}>
    <RootApp />
  </Suspense>,
);

import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { releaseFocusBeforeReload } from './ui/reloadGuard';
import { startWindowReporting } from './window-telemetry';
import './ui/app.css';

// a development reload swaps the page out from under whatever key AppKit is still interpreting
releaseFocusBeforeReload(import.meta.hot);

// failures in the window go through the main process, and through the same scrubbing
void startWindowReporting();

createRoot(document.getElementById('root')!).render(<App />);

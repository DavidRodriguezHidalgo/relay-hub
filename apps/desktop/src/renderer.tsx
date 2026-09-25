import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { releaseFocusBeforeReload } from './ui/reloadGuard';
import './ui/app.css';

// a development reload swaps the page out from under whatever key AppKit is still interpreting
releaseFocusBeforeReload(import.meta.hot);

createRoot(document.getElementById('root')!).render(<App />);

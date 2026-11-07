import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './interface.css';

if (typeof window !== 'undefined' && window.graph?.isDesktop) {
  document.documentElement.dataset.desktop = 'true';
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

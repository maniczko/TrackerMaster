import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Widget from './Widget';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Brak elementu aplikacji');
createRoot(root).render(<React.StrictMode>{getCurrentWindow().label === 'widget' ? <Widget /> : <App />}</React.StrictMode>);

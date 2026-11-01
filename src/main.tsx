import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import FreeformApp from './freeform/App';
import './styles.css';

// Vite is configured with an absolute base ('/'), and the app is served from the
// root of its own domain, so the router basename is normally '/'. The basename is
// still derived from the current URL by stripping any known route suffix, which
// keeps deep links working through the 404.html shim and under any path prefix.
// New top-level routes must be added here so deep links survive the shim.
const KNOWN_ROUTE_SUFFIXES = ['/freeform'];

function detectBasename(): string {
  const path = window.location.pathname;
  for (const suffix of KNOWN_ROUTE_SUFFIXES) {
    const match = path.match(new RegExp(`^(.*?)${suffix}/?$`));
    if (match) return match[1] || '/';
  }
  // Root route ('/' for Skitch). Strip trailing index.html and trailing slash.
  return path.replace(/\/index\.html$/, '').replace(/\/$/, '') || '/';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={detectBasename()}>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/freeform" element={<FreeformApp />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

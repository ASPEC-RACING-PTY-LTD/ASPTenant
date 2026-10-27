// Service worker for the installable mail app (scope /mail/). It caches nothing that holds mail:
// pages and the API always come from the server, so signing out or switching account never
// leaves messages on the device. When the server cannot be reached, a short offline page is
// shown instead of the browser's error.

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title><style>body{font-family:"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f6f8;color:#1b2430}@media (prefers-color-scheme: dark){body{background:#0f141c;color:#e3e8ef}}main{text-align:center;padding:24px}button{font:inherit;padding:8px 16px;border-radius:6px;border:0;background:#2b4ac7;color:#fff;cursor:pointer}</style></head><body><main><h1>You are offline</h1><p>Mail needs a connection to the server. Check your network and try again.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ),
  );
});

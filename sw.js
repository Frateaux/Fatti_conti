// Service worker: rende l'app utilizzabile anche senza connessione.
// Aumentare VERSION ad ogni modifica dei file per aggiornare la cache.
const VERSION = 'fatticonti-v3';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './lib/jspdf.umd.min.js',
  './lib/jspdf.plugin.autotable.min.js',
  './favicon.ico',
  './icons/favicon-32.png',
  './icons/icon-180.png',
  './icons/icon-maskable-512.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (così gli aggiornamenti arrivano subito), cache se offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // Google API: sempre rete
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

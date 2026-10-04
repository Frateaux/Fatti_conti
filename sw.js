// Service worker: rende l'app utilizzabile anche senza connessione.
// Strategia "prima la cache": l'app si apre SEMPRE dalla copia salvata sul dispositivo
// (istantanea, anche senza segnale) e si aggiorna in background quando c'è internet.
// Aumentare VERSION ad ogni modifica dei file per aggiornare la cache.
const VERSION = 'fatticonti-v4';
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
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Scarica i file uno per uno: se uno fallisce gli altri restano comunque salvati
    await Promise.allSettled(FILES.map(async url => {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('fatticonti-') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function aggiornaInBackground(request, cacheKey) {
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) {
      const cache = await caches.open(VERSION);
      await cache.put(cacheKey, res.clone());
    }
    return res;
  } catch (e) {
    return null;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google API: sempre rete, mai cache

  // Apertura dell'app (qualsiasi pagina): rispondi con index.html salvato
  const isPagina = req.mode === 'navigate';
  const cacheKey = isPagina ? './index.html' : req;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const inCache = await cache.match(cacheKey, { ignoreSearch: true });
    const rete = aggiornaInBackground(req, cacheKey);
    if (inCache) {
      e.waitUntil(rete);
      return inCache;
    }
    const res = await rete;
    return res || new Response('Offline: apri l\'app almeno una volta con internet.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  })());
});

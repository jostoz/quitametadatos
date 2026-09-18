// Service worker: deja la aplicación completa en caché para que funcione sin
// conexión. No hay servidor ni peticiones con datos del usuario: solo se guardan
// los archivos del propio programa (HTML, CSS, JS e iconos).
//
// Estrategia: el documento se pide a la red (para recibir mejoras) con la caché
// como respaldo, y los recursos se sirven de la caché mientras se refrescan en
// segundo plano.
const CACHE = 'sin-metadatos-v2';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './zip.js',
  './ooxml.js',
  './images.js',
  './pdf.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

function cachePut(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isDocument = request.mode === 'navigate' || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html');
  if (isDocument) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut(request, response.clone());
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          cachePut(request, response);
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});

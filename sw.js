/* Faz o app abrir sem internet e checa as contas com o app fechado. */
importScripts('dados.js');
var CACHE = 'vida-rpg-3';
var ARQ = ['./', 'index.html', 'dados.js', 'app.js', 'manifest.webmanifest', 'icone-192.png', 'icone-512.png'];
var FORA = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARQ); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('vida-rpg-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Tenta a internet primeiro; sem ela, usa a copia guardada.
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || (u.origin !== location.origin && FORA.indexOf(u.hostname) < 0)) return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok || r.type === 'opaque') { var c = r.clone(); e.waitUntil(caches.open(CACHE).then(function (k) { return k.put(e.request, c); })); }
    return r;
  }).catch(async function () { return (await caches.match(e.request)) || (e.request.mode === 'navigate' ? (await caches.match('./')) : null) || Response.error(); }));
});
self.addEventListener('periodicsync', function (e) { if (e.tag === 'contas') e.waitUntil(self.Vida.avisar(self.registration)); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (l) { return l.length ? l[0].focus() : self.clients.openWindow('./#perfil'); }));
});

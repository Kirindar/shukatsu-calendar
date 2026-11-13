// オフラインでも開けるように、アプリのファイルを端末にしまっておく。
// ネットにつながるときは新しいファイルを取りに行き（アップデートがすぐ届く）、つながらないときはしまったものを使う。
// Google とのやり取り（ログイン・Gmail・ドライブ）は、しまわない
const VERSION = '20261113113759';
const CACHE = 'shukatsu-calendar-' + VERSION;
const FILES = ['./', 'index.html', 'sheet.js', 'core.js', 'google.js', 'store.js', 'main.js', 'tour.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // ブラウザに取っておいたファイルではなく、いつも新しいファイルがないか確かめる（公開した新しい版がすぐ届くように）
  const fresh = e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache' }) : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(fresh).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});

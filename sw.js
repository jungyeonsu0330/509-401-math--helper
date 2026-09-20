/* 서비스 워커: 공유 받기(Share Target) + 오프라인 대비 캐시 */
const CACHE = 'mathconv-v4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'share').map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);

  // 다른 앱(Gemini 등)에서 "공유"로 들어온 글·이미지를 잠시 보관하고 앱 화면으로 돌려보낸다
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const fd = await req.formData();
      const c = await caches.open('share');
      // 본문(text)이 있으면 그것만 쓴다. 제목·링크는 본문이 없을 때만 대신 쓴다.
      const text = (fd.get('text') || '').toString().trim() || [fd.get('title'), fd.get('url')].filter(Boolean).join('\n');
      await c.put('text', new Response(text));
      const f = fd.get('media');
      if (f && f.size) await c.put('image', new Response(f, { headers: { 'Content-Type': f.type || 'image/png' } }));
      else await c.delete('image');
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  // 그 밖의 같은 주소 요청: 네트워크 우선, 실패하면 저장본
  if (req.method === 'GET' && url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || Response.error())));
  }
});

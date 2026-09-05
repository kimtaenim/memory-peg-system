/* 숫자 페그 서비스 워커 — 한 번 본 카드는 폰에 저장해 다음부터 즉시 뜨게 한다.
 *
 *  - 앱 껍데기(index.html, data/*.json): 네트워크 우선, 실패하면 캐시 (수정이 바로 반영되게)
 *  - 카드 그림(img/): 캐시 우선 + 뒤에서 갱신 (즉시 뜨고, 다시 뽑은 카드는 다음 방문에 반영)
 *  - 그 외 같은 출처 파일: 캐시 우선
 */
const CACHE = "peg-v1";
const SHELL = ["./", "./index.html", "./data/pegs.json", "./data/emoji.json", "./manifest.webmanifest", "./favicon.svg", "./icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isImage = url.pathname.includes("/img/");
  const isShell = url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith(".json");

  if (isImage) {
    // 캐시 우선, 뒤에서 갱신
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const refresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || refresh;
    }));
    return;
  }
  if (isShell) {
    // 네트워크 우선, 실패하면 캐시
    e.respondWith(caches.open(CACHE).then(async (c) => {
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req)) || (await c.match("./index.html"));
      }
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
});

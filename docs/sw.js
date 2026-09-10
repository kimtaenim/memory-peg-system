/* 숫자 페그 서비스 워커 — 한 번 본 카드는 폰에 저장해 다음부터 즉시 뜨게 한다.
 *
 *  - 앱 껍데기(index.html, data/*.json): 네트워크 우선, 실패하면 캐시 (수정이 바로 반영되게)
 *  - 카드 그림(img/): 캐시 우선으로 즉시 띄우고, 뒤에서 서버에 진짜로 물어봐(no-cache) 바뀌었으면
 *    캐시를 갈아끼운 뒤 화면에 알려서 그 자리에서 새 그림으로 바뀌게 한다 (다시 뽑은 카드가 바로 보이게)
 *  - 그 외 같은 출처 파일: 캐시 우선
 */
const CACHE = "peg-v3";
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

/* 화면에 줄 때는 no-store 로 표시한다. 그래야 브라우저가 그림을 메모리 캐시에 붙들고 있지 않고
 * 다음 방문 때도 서비스 워커에게 다시 물어보므로, 뒤에서 갱신한 그림이 실제로 반영된다. */
const noStore = (res) => {
  const h = new Headers(res.headers);
  h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isImage = url.pathname.includes("/img/");
  const isShell = url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith(".json");

  if (isImage) {
    // 캐시 우선, 뒤에서 갱신. 브라우저 HTTP 캐시(Pages 는 10분)를 건너뛰고 서버에 직접 확인한다.
    // 화면이 새 그림으로 바꿔 끼울 때 ?v= 를 붙여 부르므로, 캐시 키는 쿼리를 뗀 경로로 통일한다
    const key = new Request(url.origin + url.pathname);
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key);
      const refresh = fetch(new Request(key.url, { cache: "no-cache" })).then(async (res) => {
        if (!res.ok) return res;
        const tag = (r) => r.headers.get("etag") || r.headers.get("last-modified") || r.headers.get("content-length") || "";
        const changed = !hit || tag(hit) !== tag(res);
        await c.put(key, res.clone());
        if (hit && changed) {
          // 이미 옛 그림을 보여준 화면들에게 새 그림으로 바꾸라고 알린다
          const clients = await self.clients.matchAll({ type: "window" });
          for (const cl of clients) cl.postMessage({ type: "img-updated", url: key.url });
        }
        return res;
      }).catch(() => hit);
      if (hit) { e.waitUntil(refresh); return noStore(hit); }
      return refresh.then((res) => (res && res.ok ? noStore(res) : res));
    }));
    return;
  }
  if (isShell) {
    // 네트워크 우선, 실패하면 캐시
    e.respondWith(caches.open(CACHE).then(async (c) => {
      try {
        // 브라우저 HTTP 캐시(Pages 는 10분)를 건너뛰고 서버에 직접 확인한다 — 고친 앱이 바로 뜨게
        const res = await fetch(new Request(req.url, { cache: "no-cache" }));
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

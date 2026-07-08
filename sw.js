/* Section Stitch service worker — offline caching.
   Strategy:
   - App shell (html/js/css/manifest/icons): cache-first, updated in the background.
   - ONNX runtime (jsdelivr) + the model: cache-first, so after the first online load the
     whole app works fully offline.
   Bump CACHE version when you change app files to force clients to refresh. */
const CACHE = "section-stitch-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./xfeat.js",
  "./manifest.webmanifest",
  "./models/xfeat.onnx",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e)=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    // Don't fail install if an optional asset (e.g. model) isn't present yet.
    await Promise.allSettled(SHELL.map(u=>c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e)=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e)=>{
  const req=e.request;
  if(req.method!=="GET") return;
  const url=new URL(req.url);
  const isRuntime = url.hostname.includes("jsdelivr.net"); // ORT js + wasm
  const sameOrigin = url.origin===self.location.origin;

  if(sameOrigin || isRuntime){
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      const hit=await cache.match(req, {ignoreSearch:true});
      if(hit){
        // refresh in background
        fetch(req).then(r=>{ if(r&&r.ok) cache.put(req, r.clone()); }).catch(()=>{});
        return hit;
      }
      try{
        const res=await fetch(req);
        if(res&&res.ok&&(sameOrigin||isRuntime)) cache.put(req, res.clone());
        return res;
      }catch(err){
        // offline and uncached
        return hit || Response.error();
      }
    })());
  }
});

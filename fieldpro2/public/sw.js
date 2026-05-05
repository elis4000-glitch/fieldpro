const CACHE='fp-v2';
const STATIC=['/','/index.html','/catalog.html'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.url.includes('/api/')){e.respondWith(fetch(e.request).catch(()=>new Response(JSON.stringify({offline:true}),{headers:{'Content-Type':'application/json'}})));return;}
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));
});

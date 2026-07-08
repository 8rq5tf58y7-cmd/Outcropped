# Section Stitch — iOS PWA (WebGPU/Metal)

A real Progressive Web App version of the stitcher. Unlike the sandboxed artifact, this runs
in full Safari on your iPhone: **more memory, true GPU-accelerated ONNX (WebGPU/Metal on iOS 26+),
and offline use after first load** — with no App Store and no code signing.

## What you get over the artifact version
- **WebGPU execution** for the XFeat neural matcher (falls back to WASM/CPU automatically).
  On iOS 26+ Safari this is Metal-backed — roughly 20× faster than multithreaded CPU.
- **Much higher memory ceiling** — a Safari tab/PWA isn't the doubly-sandboxed iframe the
  artifact runs in, so long photo sequences (11+) fit comfortably.
- **Offline** — a service worker caches the app, the ONNX runtime, and the model after the
  first online launch.
- **Home-screen app** — "Add to Home Screen" gives it its own icon and full-screen chrome.

## One-time setup (~10 minutes, on a computer)

### 1. Add the model
Download **`xfeat.onnx`** from the XFeat-ONNX v1.0.0 release
(`github.com/DavideCatto/XFeat-ONNX/releases`) and place it at:

    pwa/models/xfeat.onnx

(The app fetches `./models/xfeat.onnx`. Without it, XFeat won't load — ORB still works.)

### 2. Host the folder (pick one — all free, all no-signing)
The app must be served over **https** (required for service workers + WebGPU). Any static host works:

**Cloudflare Pages** (drag-and-drop):
1. Go to Cloudflare Pages → "Upload assets".
2. Drag the whole `pwa/` folder in.
3. It gives you a `https://your-name.pages.dev` URL.

**GitHub Pages**:
1. Create a repo, upload the contents of `pwa/`.
2. Settings → Pages → deploy from `main` / root.
3. Use the `https://you.github.io/repo/` URL.

**Netlify**: drag the `pwa/` folder onto the Netlify "Sites" page.

> Note: some hosts don't send the cross-origin isolation headers (COOP/COEP) needed for
> *multithreaded* WASM. That only affects the CPU fallback's speed — WebGPU (the fast path
> on iOS 26+) doesn't require them. Cloudflare Pages lets you add a `_headers` file if you
> want threads; it's optional.

### 3. Install on your iPhone
1. Open the URL in **Safari** (not inside another app).
2. Share → **Add to Home Screen**.
3. Launch it from the new icon. First launch (online) caches everything; after that it's offline.

## Using it
- Add photos, choose **Matching engine → XFeat**. It initializes the GPU and shows
  "XFeat ready on GPU (WebGPU/Metal)". Stitch as before.
- ORB remains available and needs no model.

## Files
- `index.html` — app shell + UI + iOS PWA meta tags
- `app.js` — stitching pipeline (feature match → RANSAC → affine → sub-pixel polish → blend)
- `xfeat.js` — WebGPU-first ONNX runtime layer
- `sw.js` — offline caching
- `manifest.webmanifest`, `icons/` — installability
- `models/xfeat.onnx` — **you add this** (see step 1)

## Updating
When you change app files, bump `CACHE` in `sw.js` (e.g. `-v1` → `-v2`) so phones fetch the
new version instead of the cached one.

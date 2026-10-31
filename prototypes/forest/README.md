# The forest (chinmayjain.me home page)

A 2D forest you walk through: vertical scroll moves the parallax layers sideways. `.github/workflows/deploy.yml` builds this folder and deploys it to GitHub Pages.

## Run

```sh
npm run dev      # http://127.0.0.1:5180
npm run build    # TypeScript + production bundle
```

Add `?renderer=canvas` to force the canvas fallback.

## How it draws

- `forest.ts` generates the scene as SVG layers from fixed seeds. It is the single source of the art.
- `forest-webgl.ts` draws it with WebGL (PixiJS v8). Each drawing's paths are triangulated once with Pixi's `GraphicsPath`/`GraphicsContext`, then redrawn every frame at native resolution, so it stays sharp at any DPR and on pinch zoom. Scrolling only moves layer containers; no geometry is rebuilt or uploaded.
  - Load: drawings on screen are triangulated first, so the first frame comes quickly. The rest follow in ~8 ms slices, nearest first. Anything scrolled into view before its turn is triangulated on the spot.
  - Opaque rear layers are drawn front to back into stencil coverage, so each layer's opacity and fade apply once without an offscreen texture.
  - Mist and fireflies are small shader quads. Firefly motion still comes from the CSS animations. While the view is still, frames are capped at 30 fps for the fireflies.
  - `renderer.graphicsContext.updateGpuContext()` is the one internal Pixi API used. Recheck it when upgrading Pixi.
- `forest-engine.ts` picks the renderer. If WebGL is missing, fails to start, or loses its context, it falls back to the canvas-tile renderer (`forest-renderer.ts`, `forest-painter.ts`, `forest-worker.ts`), which paints layers into bitmaps in a worker.
- `index.html` has an inline loading veil. `main.ts` lifts it once the first frame is drawn and the web fonts are in, or after 6 s regardless.

## Scripts

- `scripts/screenshots.mjs`: phone (360×684 @3) and desktop (1440×900 @2) captures, dark and light, at each signpost.
- `scripts/perf.mjs`: frame times over a scripted walk. Headless Chromium renders WebGL in software (SwiftShader), so its frame rates are far below a real phone's; compare only relative numbers.
- Playwright is global: run with `NODE_PATH=/usr/lib/node_modules`.

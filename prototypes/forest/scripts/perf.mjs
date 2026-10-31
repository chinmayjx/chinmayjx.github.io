import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewports = [
  { name: 'phone', width: 360, height: 684, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
];
const targets = {
  original: process.env.ORIGINAL_URL || 'http://127.0.0.1:5185',
  webgl: process.env.WEBGL_URL || 'http://127.0.0.1:5180',
};

async function buildSizes(name) {
  const dir = path.join(root, name);
  const result = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const data = await readFile(file);
        result.push({ file: path.relative(root, file), bytes: data.byteLength, gzipBytes: gzipSync(data).byteLength });
      }
    }
  }
  try { await visit(dir); } catch { return null; }
  return { files: result, totalBytes: result.reduce((n, x) => n + x.bytes, 0), totalGzipBytes: result.reduce((n, x) => n + x.gzipBytes, 0) };
}

async function configureInstrumentation(page) {
  await page.addInitScript(() => {
    const state = { readyAt: null, readyFrameAt: null, webglCalls: { drawArrays: 0, drawElements: 0, drawArraysInstanced: 0, drawElementsInstanced: 0 }, gpuAllocationCalls: {}, gpuEstimatedBytesAllocated: 0 };
    Object.defineProperty(window, '__forestPerf', { value: state, configurable: false });
    const ready = () => {
      const landscape = document.querySelector('#landscape');
      if (!landscape || state.readyAt !== null) return;
      const isWebglReady = landscape.dataset.renderer === 'webgl' && landscape.dataset.forestReady === 'true'
        && landscape.querySelector('canvas') && landscape.dataset.firstFrameMs !== undefined;
      const isCanvasFallbackReady = landscape.dataset.renderer === 'canvas' && landscape.dataset.forestReady === 'true'
        && landscape.querySelectorAll('canvas').length >= 5;
      const isOriginalReady = !landscape.dataset.renderer && landscape.dataset.forestReady === 'true'
        && landscape.querySelectorAll('canvas').length >= 5;
      if (!isWebglReady && !isCanvasFallbackReady && !isOriginalReady) return;
      state.readyAt = performance.now();
      requestAnimationFrame(() => { state.readyFrameAt = performance.now(); });
    };
    new MutationObserver(ready).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-forest-ready'] });
    const estimateAllocation = (name, args) => {
      if (name === 'texImage2D' || name === 'texImage3D') {
        const source = args[5];
        let width, height, depth = 1;
        if (typeof args[3] === 'number' && typeof args[4] === 'number') {
          width = args[3]; height = args[4]; depth = name === 'texImage3D' && typeof args[5] === 'number' ? args[5] : 1;
        } else if (source && typeof source.width === 'number') { width = source.width; height = source.height; }
        if (width && height) return width * height * depth * 4;
      }
      if (name === 'texStorage2D' || name === 'texStorage3D') {
        const depth = name === 'texStorage3D' ? (Number(args[5]) || 1) : 1;
        return (Number(args[3]) || 0) * (Number(args[4]) || 0) * depth * 4;
      }
      if (name === 'renderbufferStorage' || name === 'renderbufferStorageMultisample') {
        return (Number(args.at(-2)) || 0) * (Number(args.at(-1)) || 0) * 4 * (name === 'renderbufferStorageMultisample' ? (Number(args[1]) || 1) : 1);
      }
      if (name === 'bufferData') {
        const value = args[1];
        return typeof value === 'number' ? value : (value?.byteLength || 0);
      }
      return 0;
    };
    const instrument = proto => {
      const methods = [...Object.keys(state.webglCalls), 'texImage2D', 'texImage3D', 'texStorage2D', 'texStorage3D', 'renderbufferStorage', 'renderbufferStorageMultisample', 'bufferData'];
      for (const name of methods) {
        const original = proto[name];
        if (typeof original !== 'function' || original.__forestWrapped) continue;
        const wrapped = function (...args) {
          if (name in state.webglCalls) state.webglCalls[name]++;
          if (/^(texImage|texStorage|renderbufferStorage|bufferData)/.test(name)) {
            const bytes = estimateAllocation(name, args);
            state.gpuAllocationCalls[name] = (state.gpuAllocationCalls[name] || 0) + 1;
            state.gpuEstimatedBytesAllocated += bytes;
          }
          return original.apply(this, args);
        };
        wrapped.__forestWrapped = true;
        try { proto[name] = wrapped; } catch { /* Some browser prototypes expose read-only methods. */ }
      }
    };
    const patchWhenAvailable = () => {
      const proto = window.WebGL2RenderingContext?.prototype || window.WebGLRenderingContext?.prototype;
      if (proto) {
        instrument(proto);
        const parent = Object.getPrototypeOf(proto);
        if (parent) instrument(parent);
      } else requestAnimationFrame(patchWhenAvailable);
    };
    patchWhenAvailable();
  });
}

async function measureTrial(browser, implementation, viewport, colorScheme, trial, durationMs = 6000) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, colorScheme, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  const assets = [];
  page.on('response', response => {
    const type = response.request().resourceType();
    if (type === 'script' || type === 'stylesheet' || type === 'worker') assets.push({ response, type });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await configureInstrumentation(page);
  const navStart = Date.now();
  const response = await page.goto(targets[implementation], { waitUntil: 'networkidle' });
  const navigationWallMs = Date.now() - navStart;
  await page.waitForFunction(() => window.__forestPerf?.readyAt !== null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const readiness = await page.evaluate(() => ({
    readyMs: window.__forestPerf.readyAt,
    firstRenderMs: window.__forestPerf.readyFrameAt,
    navigationMs: performance.getEntriesByType('navigation')[0]?.responseStart ?? null,
  }));
  await page.waitForTimeout(250);
  const initial = await page.evaluate(() => {
    const glCanvas = [...document.querySelectorAll('canvas')].find(c => c.getContext('webgl2') || c.getContext('webgl'));
    let gl = glCanvas?.getContext('webgl2') || glCanvas?.getContext('webgl');
    let webgl = null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const attrs = gl.getContextAttributes();
      webgl = { version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR), renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        samples: gl.getParameter(gl.SAMPLES), stencilBits: gl.getParameter(gl.STENCIL_BITS), depthBits: gl.getParameter(gl.DEPTH_BITS), contextAttributes: attrs };
    }
    return {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio,
      userAgent: navigator.userAgent,
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      canvasCount: document.querySelectorAll('canvas').length,
      canvasDimensions: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height })),
      canvasBackingStoreBytes: [...document.querySelectorAll('canvas')].reduce((sum, c) => sum + c.width * c.height * 4, 0),
      rendererData: { ...(document.querySelector('#landscape')?.dataset || {}) }, webgl,
    };
  });
  if (implementation === 'webgl' && (initial.rendererData.renderer !== 'webgl' || initial.rendererData.fallbackReason)) {
    await context.close();
    throw new Error(`Expected WebGL renderer; got ${initial.rendererData.renderer || 'unknown'}; fallbackReason=${initial.rendererData.fallbackReason || 'none'}`);
  }
  if (initial.innerWidth !== viewport.width || initial.innerHeight !== viewport.height || initial.devicePixelRatio !== viewport.deviceScaleFactor) {
    await context.close();
    throw new Error(`Viewport mismatch: expected ${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}, got ${initial.innerWidth}x${initial.innerHeight}@${initial.devicePixelRatio}`);
  }
  const frames = await page.evaluate(duration => new Promise(resolve => {
    const walk = document.querySelector('#walk');
    const stage = document.querySelector('.stage');
    const range = Math.max(0, walk.offsetHeight - stage.clientHeight);
    const deltas = [];
    const rendererStats = [];
    let start;
    let previous;
    function step(now) {
      if (start === undefined) start = previous = now;
      else deltas.push(now - previous);
      previous = now;
      const progress = Math.min(1, (now - start) / duration);
      window.scrollTo(0, range * progress);
      const data = document.querySelector('#landscape')?.dataset;
      if (data) rendererStats.push({ drawCalls: Number(data.drawCalls) || 0, visibleTriangles: Number(data.visibleTriangles) || 0 });
      if (progress < 1) requestAnimationFrame(step);
      else resolve({ deltas, elapsedMs: now - start, rendererStats });
    }
    requestAnimationFrame(step);
  }), durationMs);
  const after = await page.evaluate(() => ({
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    webglCalls: { ...window.__forestPerf.webglCalls },
    gpuAllocationCalls: { ...window.__forestPerf.gpuAllocationCalls },
    gpuEstimatedBytesAllocated: window.__forestPerf.gpuEstimatedBytesAllocated,
    rendererData: { ...(document.querySelector('#landscape')?.dataset || {}) },
  }));
  const loadedAssets = await Promise.all(assets.map(async ({ response, type }) => {
    try {
      const body = await response.body();
      return { type, url: response.url(), status: response.status(), bytes: body.byteLength, gzipBytes: gzipSync(body).byteLength };
    } catch { return { type, url: response.url(), status: response.status(), bytes: null, gzipBytes: null }; }
  }));
  await context.close();
  const sorted = [...frames.deltas].sort((a, b) => a - b);
  const statsRange = key => {
    const values = frames.rendererStats.map(s => s[key]).filter(Number.isFinite);
    return values.length ? { min: Math.min(...values), max: Math.max(...values), first: values[0], last: values.at(-1), samples: values.length } : null;
  };
  return {
    implementation, viewport: viewport.name, width: viewport.width, height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor, colorScheme, trial,
    actualViewport: { width: initial.innerWidth, height: initial.innerHeight, deviceScaleFactor: initial.devicePixelRatio },
    httpStatus: response?.status() ?? null, navigationWallMs,
    readinessMs: readiness.readyMs, readyToFirstAnimationFrameMs: readiness.firstRenderMs === null ? null : readiness.firstRenderMs - readiness.readyMs,
    responseStartMs: readiness.navigationMs,
    userAgent: initial.userAgent, webgl: initial.webgl,
    heapStartBytes: initial.heapUsedBytes, heapEndBytes: after.heapUsedBytes,
    canvasCount: initial.canvasCount, canvasBackingStoreBytes: initial.canvasBackingStoreBytes,
    canvasDimensions: initial.canvasDimensions,
    defaultFramebufferMsaaEstimateBytes: initial.webgl?.contextAttributes?.antialias
      ? (initial.canvasDimensions.find(c => c.width > 0 && c.height > 0)?.width || 0)
        * (initial.canvasDimensions.find(c => c.width > 0 && c.height > 0)?.height || 0)
        * (initial.webgl.samples || 1)
        * (4 + Math.ceil((initial.webgl.depthBits || 0) / 8) + Math.ceil((initial.webgl.stencilBits || 0) / 8))
      : null,
    rendererDataStart: initial.rendererData, rendererDataEnd: after.rendererData,
    webglCalls: after.webglCalls, gpuAllocationCalls: after.gpuAllocationCalls, gpuEstimatedBytesAllocated: after.gpuEstimatedBytesAllocated, frameCount: frames.deltas.length,
    loadedAssets, loadedJavaScriptBytes: loadedAssets.filter(a => a.type === 'script').reduce((n, a) => n + (a.bytes || 0), 0),
    loadedJavaScriptGzipBytes: loadedAssets.filter(a => a.type === 'script' || a.type === 'worker').reduce((n, a) => n + (a.gzipBytes || 0), 0),
    loadedStylesheetBytes: loadedAssets.filter(a => a.type === 'stylesheet').reduce((n, a) => n + (a.bytes || 0), 0),
    loadedStylesheetGzipBytes: loadedAssets.filter(a => a.type === 'stylesheet').reduce((n, a) => n + (a.gzipBytes || 0), 0),
    rendererStatsRange: { drawCalls: statsRange('drawCalls'), visibleTriangles: statsRange('visibleTriangles') },
    elapsedMs: +frames.elapsedMs.toFixed(2), averageFps: +(1000 * frames.deltas.length / frames.elapsedMs).toFixed(2),
    p50FrameMs: +sorted[Math.floor(sorted.length * .5)].toFixed(2),
    p95FrameMs: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2),
    framesOver33Ms: frames.deltas.filter(ms => ms > 33).length,
    framesOver50Ms: frames.deltas.filter(ms => ms > 50).length,
    errors, frameMs: frames.deltas,
  };
}

export async function runBenchmarks(browser, { trials = Number(process.env.TRIALS || 3), implementations = ['original', 'webgl'], viewportNames = viewports.map(v => v.name), schemes = ['dark', 'light'], durationMs = 6000, outputName = 'results.json', onRecord = null } = {}) {
  const records = [];
  // Interleave implementations to reduce systematic warm-up / time drift bias.
  const selectedViewports = viewports.filter(v => viewportNames.includes(v.name));
  for (const viewport of selectedViewports) for (const colorScheme of schemes) for (let trial = 1; trial <= trials; trial++) {
    for (const implementation of implementations) {
      const record = await measureTrial(browser, implementation, viewport, colorScheme, trial, durationMs);
      records.push(record);
      onRecord?.(record, records.length);
    }
  }
  const summaries = [];
  for (const implementation of implementations) for (const viewport of selectedViewports) for (const colorScheme of schemes) {
    const group = records.filter(r => r.implementation === implementation && r.viewport === viewport.name && r.colorScheme === colorScheme);
    const median = key => {
      const values = group.map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    };
    summaries.push({ implementation, viewport: viewport.name, width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, colorScheme,
      trials: group.length, medianAverageFps: median('averageFps'), medianP95FrameMs: median('p95FrameMs'), medianFramesOver33Ms: median('framesOver33Ms'),
      medianReadyMs: median('readinessMs'), medianHeapStartBytes: median('heapStartBytes'), medianHeapEndBytes: median('heapEndBytes'),
      medianCanvasBackingStoreBytes: median('canvasBackingStoreBytes'), medianGpuEstimatedBytesAllocated: median('gpuEstimatedBytesAllocated'), rendererData: group.at(-1)?.rendererDataEnd, webgl: group.at(-1)?.webgl,
      framebufferMsaaEstimateBytes: group.at(-1)?.defaultFramebufferMsaaEstimateBytes ?? null,
      medianLoadedJavaScriptGzipBytes: median('loadedJavaScriptGzipBytes'), medianLoadedStylesheetGzipBytes: median('loadedStylesheetGzipBytes'),
    });
  }
  const output = { generatedAt: new Date().toISOString(), browser: browser.version(), chromiumArgs: ['--enable-unsafe-swiftshader'], cpuThrottling: '1x (not throttled)',
    methodology: `Fresh browser context for every trial; sequential scripted ${durationMs / 1000}-second scroll from top to bottom; ${schemes.join('/')} color scheme; ${trials} trials per selected viewport and implementation. Frame deltas from requestAnimationFrame timestamps.`,
    memoryNotes: 'JS heap is Chromium performance.memory and may be unavailable; it measures the main thread only and excludes worker heaps. Canvas backing store is width×height×4 and excludes compositor/GPU copies. WebGL allocation counts estimate requested bytes for texture, renderbuffer, and buffer storage; they are cumulative, do not subtract deallocations, omit format-specific bytes-per-pixel/mipmap factors, and are not resident VRAM. Renderer datasets and the default-framebuffer MSAA/stencil estimate are approximate. SwiftShader is software WebGL and is not representative of physical phone GPUs.',
    targets, buildSizes: { baseline: await buildSizes('baseline-dist'), webgl: await buildSizes('dist') }, summaries, trials: records };
  const outDir = path.join(root, 'screenshots', 'perf');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, outputName), JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try { console.log(JSON.stringify(await runBenchmarks(browser), null, 2)); }
  finally { await browser.close(); }
}

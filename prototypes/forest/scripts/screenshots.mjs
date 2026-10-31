import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stops = ['entrance', 'mind', 'philosophy', 'ai', 'clearing'];
const configs = [
  { device: 'phone', width: 360, height: 684, dpr: 3, mobile: true },
  { device: 'desktop', width: 1440, height: 900, dpr: 2, mobile: false },
];

function urls() {
  return {
    original: process.env.ORIGINAL_URL || 'http://127.0.0.1:5185',
    webgl: process.env.WEBGL_URL || 'http://127.0.0.1:5180',
  };
}

async function stabilize(page) {
  await page.addStyleTag({ content: `.firefly { animation-delay: 0s !important; animation-duration: 1s !important; animation-iteration-count: 1 !important; animation-play-state: paused !important; } *, *::before, *::after { animation-play-state: paused !important; caret-color: transparent !important; }` });
  await page.evaluate(() => document.fonts.ready);
}

async function goToStop(page, stop) {
  await page.evaluate(stopName => {
    const stage = document.querySelector('.stage');
    const node = document.querySelector(stopName === 'entrance' ? '.entrance' : stopName === 'clearing' ? '#clearing' : `.sign-${stopName}`);
    if (!stage || !node) throw new Error(`Missing stage or stop ${stopName}`);
    const scale = stage.clientHeight / 900;
    const distance = 4140 * scale - stage.clientWidth / 2;
    const scrollRange = document.querySelector('#walk').offsetHeight - stage.clientHeight;
    const x = Number(node.dataset.worldX || 0);
    const progress = Math.max(0, Math.min(1, (x * scale - stage.clientWidth / 2) / distance));
    window.scrollTo(0, progress * scrollRange);
  }, stop);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.querySelector('[data-forest-ready="false"]'));
}

async function comparePair(browser, originalPath, webglPath, outputPath, config) {
  const page = await browser.newPage({ viewport: { width: config.width * 2, height: config.height * 2 }, deviceScaleFactor: config.dpr });
  // Read files in Node and let Chromium composite the PNGs without adding a dependency.
  const { readFile } = await import('node:fs/promises');
  const left = `data:image/png;base64,${(await readFile(originalPath)).toString('base64')}`;
  const right = `data:image/png;base64,${(await readFile(webglPath)).toString('base64')}`;
  await page.setContent(`<canvas id="pair" style="width:${config.width * 2}px;height:auto"></canvas>`);
  await page.evaluate(async ({ left, right }) => {
    const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const [a, b] = await Promise.all([load(left), load(right)]);
    const canvas = document.querySelector('#pair');
    canvas.width = a.width + b.width; canvas.height = Math.max(a.height, b.height);
    const context = canvas.getContext('2d');
    context.drawImage(a, 0, 0); context.drawImage(b, a.width, 0);
    const density = devicePixelRatio;
    context.font = `600 ${18 * density}px system-ui, sans-serif`;
    context.textBaseline = 'top';
    for (const [label, x] of [['Original', 18 * density], ['WebGL', a.width + 18 * density]]) {
      const width = context.measureText(label).width + 22 * density;
      context.fillStyle = '#07151dcc'; context.fillRect(x - 8 * density, 8 * density, width, 32 * density);
      context.fillStyle = '#fff'; context.fillText(label, x, 14 * density);
    }
  }, { left, right });
  await page.locator('#pair').screenshot({ path: outputPath });
  await page.close();
}

async function captureSet(browser, source, config, scheme, baseDir, errors, chosenStops = stops) {
  const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, deviceScaleFactor: config.dpr, isMobile: config.mobile, hasTouch: config.mobile, colorScheme: scheme, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ source, device: config.device, scheme, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ source, device: config.device, scheme, message: message.text() }); });
  await page.goto(urls()[source], { waitUntil: 'networkidle' });
  await stabilize(page);
  const captures = [];
  for (const stop of chosenStops) {
    await goToStop(page, stop);
    const file = path.join(baseDir, source, `${config.device}-${scheme}-${stop}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    captures.push(file);
  }
  const status = await page.evaluate(() => ({ actualDpr: devicePixelRatio, renderer: document.querySelector('#landscape')?.dataset.renderer, fallbackReason: document.querySelector('#landscape')?.dataset.fallbackReason, dataset: { ...document.querySelector('#landscape')?.dataset } }));
  if (source === 'webgl' && status.renderer !== 'webgl') errors.push({ source, device: config.device, scheme, message: `Expected WebGL renderer; got ${status.renderer || 'unset'}${status.fallbackReason ? ` (${status.fallbackReason})` : ''}` });
  await context.close();
  return { captures, ...status };
}

export async function captureForest(browser, round = 'final') {
  const dirs = Object.fromEntries(['original', 'webgl', 'compare'].map(name => [name, path.join(root, 'screenshots', name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));
  const errors = [];
  const captures = [];
  const dprs = {};
  const rendererStatus = {};
  const selectedDevices = (process.env.CAPTURE_DEVICES || 'phone,desktop').split(',');
  const selectedSchemes = (process.env.CAPTURE_SCHEMES || 'dark,light').split(',');
  const selectedStops = (process.env.CAPTURE_STOPS || stops.join(',')).split(',');
  const requestedPairs = process.env.CAPTURE_PAIRS?.split(',');
  for (const config of configs.filter(item => selectedDevices.includes(item.device))) for (const scheme of selectedSchemes) {
    if (requestedPairs && !requestedPairs.includes(`${config.device}:${scheme}`)) continue;
    const pair = {};
    for (const source of ['original', 'webgl']) {
      const result = await captureSet(browser, source, config, scheme, path.join(root, 'screenshots'), errors, selectedStops);
      pair[source] = result.captures;
      dprs[`${source}-${config.device}`] = result.actualDpr;
      rendererStatus[`${source}-${config.device}-${scheme}`] = result.dataset;
      captures.push(...result.captures);
    }
    for (let i = 0; i < selectedStops.length; i++) {
      const file = path.join(dirs.compare, `${config.device}-${scheme}-${selectedStops[i]}.png`);
      await comparePair(browser, pair.original[i], pair.webgl[i], file, config);
      captures.push(file);
    }
  }
  const diagnostics = await runDiagnostics(browser, errors);
  const report = { captures, errors, dprs, rendererStatus, diagnostics, urls: urls() };
  await writeFile(path.join(root, 'screenshots', `capture-report-${round}.json`), JSON.stringify(report, null, 2));
  return report;
}

export async function runDiagnostics(browser, errors = []) {
  const results = {};
  const context = await browser.newContext({ viewport: { width: 360, height: 684 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ source: 'webgl-diagnostics', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ source: 'webgl-diagnostics', message: message.text() }); });
  const webglUrl = urls().webgl;
  await page.goto(webglUrl, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  results.skipFocus = await page.evaluate(() => ({ focused: document.activeElement?.className, visible: document.querySelector('.skip-link').getBoundingClientRect().top >= 0 }));
  await page.locator('.skip-link').click();
  results.skip = await page.evaluate(() => ({ focused: document.activeElement?.tagName, stop: document.activeElement?.closest('#clearing')?.id, scrollY }));
  await page.locator('.return-link').click();
  results.return = await page.evaluate(() => ({ focused: document.activeElement?.className, scrollY }));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  results.waypointFocus = await page.evaluate(() => ({ focused: document.activeElement?.className, scrollY }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  results.reducedMotion = await page.evaluate(() => ({ media: matchMedia('(prefers-reduced-motion: reduce)').matches, walkHeight: document.querySelector('#walk').style.height }));
  await page.emulateMedia({ colorScheme: 'dark' });
  const before = await page.locator('.sky').evaluate(el => getComputedStyle(el).backgroundImage);
  await page.emulateMedia({ colorScheme: 'light' });
  const after = await page.locator('.sky').evaluate(el => getComputedStyle(el).backgroundImage);
  results.runtimeScheme = { before, after, changed: before !== after };
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(120);
  results.reducedMotionToggleBack = await page.evaluate(() => ({ media: matchMedia('(prefers-reduced-motion: reduce)').matches, walkHeight: document.querySelector('#walk').style.height }));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(150);
  results.resize = await page.evaluate(() => ({ width: innerWidth, stageWidth: document.querySelector('.stage').clientWidth, dpr: devicePixelRatio }));

  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => scrollTo(0, 0));
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await cdp.send('Input.synthesizeScrollGesture', { x: 180, y: 340, xDistance: 0, yDistance: -300, gestureSourceType: 'touch', speed: 600 });
  await page.waitForTimeout(250);
  results.pinchZoom = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.forest-webgl');
    const vv = visualViewport;
    return { scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, pageLeft: vv.pageLeft, pageTop: vv.pageTop, scrollY, width: vv.width, height: vv.height, dpr: devicePixelRatio, canvas: canvas && { width: canvas.width, height: canvas.height }, backingMb: document.querySelector('#landscape').dataset.canvasMb };
  });
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 800 });
  await page.waitForTimeout(500);
  results.dprChange = await page.evaluate(() => ({ dpr: devicePixelRatio, resolution: document.querySelector('#landscape').dataset.resolution, canvas: { width: document.querySelector('canvas.forest-webgl')?.width, height: document.querySelector('canvas.forest-webgl')?.height } }));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForFunction(() => document.querySelector('#landscape')?.dataset.forestReady === 'true', { timeout: 15000 }).catch(() => {});
  results.webglStatus = await page.locator('#landscape').evaluate(el => ({ ...el.dataset }));
  await context.close();

  for (const [name, suffix] of [['canvasFallback', '?renderer=canvas']]) {
    const fallback = await browser.newPage({ viewport: { width: 360, height: 684 }, deviceScaleFactor: 3 });
    await fallback.goto(`${webglUrl.replace(/\/$/, '')}/${suffix}`, { waitUntil: 'networkidle' });
    await fallback.waitForFunction(() => document.querySelector('#landscape')?.dataset.forestReady === 'true', { timeout: 15000 }).catch(() => {});
    results[name] = await fallback.evaluate(() => ({ query: location.search, ready: !document.querySelector('[data-forest-ready="false"]'), canvasCount: document.querySelectorAll('canvas').length, dataset: { ...document.querySelector('#landscape')?.dataset } }));
    await fallback.close();
  }

  if (results.webglStatus.renderer === 'webgl') {
    const lossContext = await browser.newContext({ viewport: { width: 360, height: 684 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const lossPage = await lossContext.newPage();
    lossPage.on('pageerror', error => errors.push({ source: 'context-loss', message: error.message }));
    lossPage.on('console', message => { if (message.type() === 'error') errors.push({ source: 'context-loss', message: message.text() }); });
    await lossPage.goto(webglUrl, { waitUntil: 'networkidle' });
    await lossPage.waitForFunction(() => document.querySelector('#landscape')?.dataset.forestReady === 'true', { timeout: 20000 });
    results.contextLossSupported = await lossPage.locator('canvas.forest-webgl').evaluate(canvas => Boolean(canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')));
    await lossPage.locator('canvas.forest-webgl').evaluate(canvas => canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext());
    await lossPage.waitForFunction(() => document.querySelector('#landscape')?.dataset.renderer === 'canvas' && document.querySelector('#landscape')?.dataset.forestReady === 'true', { timeout: 20000 }).catch(() => {});
    results.contextLossFallback = await lossPage.locator('#landscape').evaluate(el => ({ ...el.dataset }));
    await lossPage.locator('.skip-link').focus();
    await lossPage.keyboard.press('Enter');
    results.linksAfterContextLoss = await lossPage.evaluate(() => ({ focusedClearing: Boolean(document.activeElement?.closest('#clearing')), renderer: document.querySelector('#landscape').dataset.renderer }));
    await lossContext.close();
  } else results.contextLossSkipped = 'WebGL backend unavailable in this browser run';
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium } = await import('/usr/lib/node_modules/playwright/index.mjs').catch(() => import('@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', ...(process.env.NO_WEBGL ? ['--disable-webgl', '--disable-3d-apis'] : [])], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    if (process.env.DIAGNOSTICS_ONLY === '1') { const errors = []; console.log(JSON.stringify({ diagnostics: await runDiagnostics(browser, errors), errors }, null, 2)); }
    else console.log(JSON.stringify(await captureForest(browser, process.argv[2] || 'final'), null, 2));
  } finally { await browser.close(); }
}

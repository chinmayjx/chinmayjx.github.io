import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fresh mobile context per scheme; includes cold tiles encountered on the walk. */
export async function measureForest(browser, round = 'after') {
  const results = [];
  for (const colorScheme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 684 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true, colorScheme, reducedMotion: 'no-preference',
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => !document.querySelector('[data-forest-ready="false"]'));
      await page.waitForTimeout(700);
      const counts = await page.evaluate(() => ({
        elements: document.querySelectorAll('*').length,
        forestElements: document.querySelectorAll('#landscape *').length,
        layerElements: [...document.querySelectorAll('svg.world-layer')].map(layer => ({
          layer: layer.classList[1], elements: layer.querySelectorAll('*').length,
        })),
      }));
      const frames = await page.evaluate(() => new Promise(resolve => {
        const duration = 6000;
        const range = document.querySelector('#walk').offsetHeight - document.querySelector('.stage').clientHeight;
        const deltas = [];
        let start, previous;
        function step(now) {
          if (start === undefined) start = previous = now;
          else deltas.push(now - previous);
          previous = now;
          const progress = Math.min(1, (now - start) / duration);
          window.scrollTo(0, range * progress);
          if (progress < 1) requestAnimationFrame(step);
          else resolve({ deltas, elapsed: now - start });
        }
        requestAnimationFrame(step);
      }));
      const memory = await page.evaluate(() => ({
        canvasCount: document.querySelectorAll('canvas').length,
        canvasMB: [...document.querySelectorAll('canvas')].reduce((sum, c) => sum + c.width * c.height * 4, 0) / 1024 ** 2,
        renderer: document.querySelector('#landscape')?.dataset,
      }));
      const sorted = [...frames.deltas].sort((a, b) => a - b);
      results.push({
        colorScheme, averageFps: +(1000 * frames.deltas.length / frames.elapsed).toFixed(2),
        p95FrameMs: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2),
        framesOver33Ms: frames.deltas.filter(ms => ms > 33).length,
        frameCount: frames.deltas.length, elapsedMs: +frames.elapsed.toFixed(1),
        ...counts, ...memory, errors, frameMs: frames.deltas,
      });
    } finally { await context.close(); }
  }
  await mkdir(path.join(root, 'screenshots', round), { recursive: true });
  await writeFile(path.join(root, 'screenshots', round, 'perf.json'), JSON.stringify(results, null, 2));
  return results.map(({ frameMs, ...summary }) => summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try { console.log(JSON.stringify(await measureForest(browser, process.argv[2] || 'after'), null, 2)); }
  finally { await browser.close(); }
}

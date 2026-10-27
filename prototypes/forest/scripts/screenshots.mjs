import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Also callable with the page supplied by the Playwright MCP browser. */
export async function captureForest(page, round = 'final') {
  const folder = path.join(root, 'screenshots', round);
  await mkdir(folder, { recursive: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const captures = [];
  for (const [device, viewport] of Object.entries({ phone: { width: 360, height: 684 }, desktop: { width: 1440, height: 900 } })) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
      await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.addStyleTag({ content: '.firefly { animation-play-state: paused !important; }' });
      for (const stop of ['entrance', 'mind', 'philosophy', 'ai', 'clearing']) {
        await page.evaluate(stop => {
          const stage = document.querySelector('.stage');
          const scale = stage.clientHeight / 900;
          const distance = 4140 * scale - stage.clientWidth / 2;
          const scrollRange = document.querySelector('#walk').offsetHeight - stage.clientHeight;
          const node = document.querySelector(stop === 'clearing' ? '#clearing' : `.sign-${stop}`);
          const worldX = node ? Number(node.dataset.worldX) : 0;
          const progress = Math.max(0, Math.min(1, (worldX * scale - stage.clientWidth / 2) / distance));
          window.scrollTo(0, progress * scrollRange);
        }, stop);
        await page.waitForTimeout(180);
        await page.waitForFunction(() => !document.querySelector('[data-forest-ready="false"]'));
        const file = path.join(folder, `${device}-${colorScheme}-${stop}.png`);
        await page.screenshot({ path: file, animations: 'disabled' });
        captures.push(file);
      }
    }
  }
  await page.setViewportSize({ width: 360, height: 684 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('[data-forest-ready="false"]'));
  await page.screenshot({ path: path.join(folder, 'phone-dark-reduced-motion.png'), fullPage: true });
  const reduced = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    links: [...document.querySelectorAll('#waypoints a')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href'), top: a.getBoundingClientRect().top })),
    animations: document.getAnimations().filter(a => a.playState === 'running').length,
  }));
  const report = { captures, errors, reduced };
  await writeFile(path.join(folder, 'capture-report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    console.log(JSON.stringify(await captureForest(page, process.argv[2] || 'final'), null, 2));
  } finally {
    await browser.close();
  }
}

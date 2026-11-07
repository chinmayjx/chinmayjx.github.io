// Night rain without per-frame work: each depth layer is a seamless SVG tile of streaks
// (they wrap around the tile's edges), slid diagonally by exactly one tile per loop with a
// CSS transform. Moving a tile by its own size gives the same picture, so the loop never
// jumps, and the slant comes from the tile's shape: width / height.
type RainLayer = { width: number; height: number; drops: number; length: [number, number]; stroke: [number, number]; alpha: [number, number]; seconds: number };

const LAYERS: RainLayer[] = [
  { width: 150, height: 600, drops: 16, length: [10, 16], stroke: [.6, .8], alpha: [.12, .22], seconds: 1.15 },
  { width: 220, height: 880, drops: 12, length: [16, 26], stroke: [.9, 1.2], alpha: [.2, .32], seconds: .95 },
  { width: 300, height: 1200, drops: 7, length: [26, 40], stroke: [1.3, 1.7], alpha: [.3, .45], seconds: .8 },
];

function random(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 2 ** 32;
}

function tile({ width, height, drops, length, stroke, alpha }: RainLayer, rng: () => number) {
  const slant = width / height;
  let lines = '';
  for (let i = 0; i < drops; i++) {
    const x = rng() * width, y = rng() * height;
    const len = length[0] + rng() * (length[1] - length[0]);
    const w = (stroke[0] + rng() * (stroke[1] - stroke[0])).toFixed(2);
    const a = (alpha[0] + rng() * (alpha[1] - alpha[0])).toFixed(2);
    // Draw the streak and its wrapped copies, so the tile repeats without seams.
    for (const dx of [-width, 0, width]) for (const dy of [-height, 0, height]) {
      const x1 = x + dx, y1 = y + dy, x0 = x1 - len * slant, y0 = y1 - len;
      if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > width || y1 < 0 || y0 > height) continue;
      lines += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke-width="${w}" stroke-opacity="${a}"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g stroke="#b9d3d1" stroke-linecap="round">${lines}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function startRain(stage: HTMLElement) {
  const rain = document.createElement('div');
  rain.className = 'rain';
  rain.setAttribute('aria-hidden', 'true');
  const rng = random(907);
  for (const layer of LAYERS) {
    const sheet = document.createElement('div');
    sheet.className = 'rain-layer';
    sheet.style.setProperty('--w', `${layer.width}px`);
    sheet.style.setProperty('--h', `${layer.height}px`);
    sheet.style.backgroundImage = tile(layer, rng);
    sheet.style.backgroundSize = `${layer.width}px ${layer.height}px`;
    sheet.style.animationDuration = `${layer.seconds}s`;
    rain.append(sheet);
  }
  stage.querySelector('#landscape')!.after(rain);
}

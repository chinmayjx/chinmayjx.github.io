import './style.css';
import { drawForest } from './forest';
import { ForestEngine } from './forest-engine';

const landscape = document.querySelector<HTMLDivElement>('#landscape')!;
landscape.innerHTML = drawForest();
const forest = new ForestEngine(landscape, queueRender);

// The loading veil (index.html) lifts once the first forest frame is drawn, or after
// a few seconds whatever happens, so a slow or failing renderer never hides the page.
// It also waits for the fonts, so the signposts don't change typeface in view.
function lift() { document.documentElement.classList.add('forest-ready'); }
const drawn = new Promise<void>(resolve => new MutationObserver((_, observer) => {
  if (landscape.dataset.forestReady === 'true') { observer.disconnect(); resolve(); }
}).observe(landscape, { attributes: true, attributeFilter: ['data-forest-ready'] }));
const fontSheet = document.querySelector<HTMLLinkElement>('link[rel=stylesheet][href*="fonts.googleapis"]');
const fonts = new Promise(resolve => {
  if (!fontSheet || fontSheet.dataset.loaded !== undefined) resolve(null);
  else { fontSheet.addEventListener('load', resolve); fontSheet.addEventListener('error', resolve); }
}).then(() => Promise.all(['500 1em Caveat', '1em Lora'].map(font => document.fonts.load(font))));
Promise.all([drawn, fonts]).then(lift);
setTimeout(lift, 6000);

// A small, static noise texture; no SVG filter repaints as the scene moves.
const noise = document.createElement('canvas');
noise.width = noise.height = 160;
const noiseContext = noise.getContext('2d')!;
const pixels = noiseContext.createImageData(160, 160);
let noiseSeed = 71;
for (let i = 0; i < pixels.data.length; i += 4) {
  for (let channel = 0; channel < 3; channel++) {
    noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) | 0;
    pixels.data[i + channel] = 64 + ((noiseSeed >>> 24) >> 1);
  }
  pixels.data[i + 3] = 179;
}
noiseContext.putImageData(pixels, 0, 0);
document.querySelector<HTMLElement>('.grain')!.style.backgroundImage = `url(${noise.toDataURL()})`;
noise.width = noise.height = 0;

const walk = document.querySelector<HTMLElement>('#walk')!;
const stage = document.querySelector<HTMLElement>('.stage')!;
const entrance = document.querySelector<HTMLElement>('.entrance')!;
const hint = document.querySelector<HTMLElement>('.walk-hint')!;
const progressBar = document.querySelector<HTMLElement>('.journey-progress')!;
const waypoints = document.querySelector<HTMLElement>('#waypoints')!;
const layers = [...document.querySelectorAll<HTMLElement>('[data-speed]:not(svg)')].map(element => ({
  element, speed: Number(element.dataset.speed),
}));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const stops = [...document.querySelectorAll<HTMLElement>('[data-world-x]')];
const CLEARING_X = 4140;
let scale = 1;
let viewportWidth = 0;
let travel = 0;
let scrollRange = 1;
let frame = 0;
let previousWidth = 0;
let previousHeight = 0;
let previousDpr = 0;
let previousZoom = 0;

function render() {
  frame = 0;
  if (reducedMotion.matches) { forest.render(0); return; }
  const progress = Math.max(0, Math.min(1, window.scrollY / scrollRange));
  const offset = progress * travel;
  forest.render(offset);
  for (const { element, speed } of layers) {
    element.style.transform = `translate3d(${-offset * speed}px,0,0)`;
  }
  entrance.style.transform = `translate3d(${-offset * .4}px,0,0)`;
  entrance.style.opacity = `${Math.max(0, 1 - offset / (viewportWidth * .22))}`;
  hint.style.opacity = `${Math.max(0, 1 - progress * 20)}`;
  progressBar.style.transform = `scaleX(${progress})`;
  // A link reached with Tab is brought into view by the focus handler below.
  // Only the current camera position is written here; no layout reads on scroll.
}

function queueRender() {
  if (!frame) frame = requestAnimationFrame(render);
}

function measure() {
  const height = stage.clientHeight;
  const width = stage.clientWidth;
  if (height === previousHeight && width === previousWidth && previousDpr === devicePixelRatio && previousZoom === (visualViewport?.scale || 1)) return;
  previousHeight = height;
  previousWidth = width;
  previousDpr = devicePixelRatio;
  previousZoom = visualViewport?.scale || 1;
  scale = height / 900;
  viewportWidth = width;
  document.documentElement.style.setProperty('--unit', `${scale}px`);
  travel = CLEARING_X * scale - width / 2;
  // One pixel of ordinary vertical scroll covers about one pixel of the path.
  scrollRange = Math.max(2400, travel * 1.25);
  walk.style.height = reducedMotion.matches ? '' : `${height + scrollRange}px`;
  layers.forEach(({ element }) => {
    if (element.dataset.width) element.style.width = `${Number(element.dataset.width) * scale}px`;
  });
  stops.forEach(stop => {
    stop.style.left = `${Number(stop.dataset.worldX) * scale}px`;
  });
  waypoints.style.width = `${5200 * scale}px`;
  forest.resize(width, landscape.clientHeight, scale, reducedMotion.matches);
  queueRender();
}

function motionPreferenceChanged() {
  previousHeight = 0;
  if (reducedMotion.matches) {
    layers.forEach(({ element }) => { element.style.transform = ''; });
    entrance.style.transform = '';
    entrance.style.opacity = '';
    hint.style.opacity = '';
  }
  measure();
}

window.addEventListener('scroll', queueRender, { passive: true });
window.addEventListener('resize', measure);
visualViewport?.addEventListener('resize', measure);
visualViewport?.addEventListener('scroll', queueRender);
document.addEventListener('visibilitychange', queueRender);
// A monitor move can change DPR without changing the CSS viewport.
function watchDensity() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { measure(); watchDensity(); }, { once: true });
}
watchDensity();
new ResizeObserver(measure).observe(stage);
reducedMotion.addEventListener('change', motionPreferenceChanged);
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => forest.recolor());

function goToStop(stop: HTMLElement) {
  if (reducedMotion.matches) return;
  const target = Math.max(0, Math.min(1, (Number(stop.dataset.worldX) * scale - viewportWidth / 2) / travel));
  window.scrollTo({ top: target * scrollRange, behavior: 'instant' });
  render();
}

stops.forEach(stop => {
  stop.addEventListener('focusin', () => goToStop(stop));
});
document.querySelector<HTMLAnchorElement>('.skip-link')!.addEventListener('click', event => {
  if (reducedMotion.matches) return;
  event.preventDefault();
  const clearing = document.querySelector<HTMLElement>('#clearing')!;
  goToStop(clearing);
  clearing.querySelector<HTMLAnchorElement>('a')!.focus({ preventScroll: true });
});
document.querySelector<HTMLButtonElement>('.return-link')!.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelector<HTMLAnchorElement>('.skip-link')!.focus({ preventScroll: true });
});
// Work and Resume are deliberately local placeholders in this visual study.
document.querySelectorAll<HTMLAnchorElement>('[data-placeholder]').forEach(link => {
  link.addEventListener('click', event => event.preventDefault());
});
measure();

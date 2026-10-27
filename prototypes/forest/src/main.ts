import './style.css';
import { drawForest } from './forest';

const landscape = document.querySelector<HTMLDivElement>('#landscape')!;
landscape.innerHTML = drawForest();

const walk = document.querySelector<HTMLElement>('#walk')!;
const stage = document.querySelector<HTMLElement>('.stage')!;
const entrance = document.querySelector<HTMLElement>('.entrance')!;
const hint = document.querySelector<HTMLElement>('.walk-hint')!;
const progressBar = document.querySelector<HTMLElement>('.journey-progress')!;
const waypoints = document.querySelector<HTMLElement>('#waypoints')!;
const layers = [...document.querySelectorAll<HTMLElement | SVGElement>('[data-speed]')].map(element => ({
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

function render() {
  frame = 0;
  if (reducedMotion.matches) return;
  const progress = Math.max(0, Math.min(1, window.scrollY / scrollRange));
  const offset = progress * travel;
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
  if (height === previousHeight && width === previousWidth) return;
  previousHeight = height;
  previousWidth = width;
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
new ResizeObserver(measure).observe(stage);
reducedMotion.addEventListener('change', motionPreferenceChanged);

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

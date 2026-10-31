/** ?fps: a small live readout for checking the forest on real devices. */
export function startFpsOverlay(landscape: HTMLElement) {
  const box = document.createElement('pre');
  box.className = 'fps-overlay';
  document.body.append(box);
  let frames: number[] = [], last = performance.now(), slow = 0, worst = 0, total = 0;
  function tick(now: number) {
    const delta = now - last; last = now;
    frames.push(now); total++;
    if (delta > 20) slow++;
    worst = Math.max(worst, delta);
    while (frames.length && frames[0] < now - 1000) frames.shift();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  setInterval(() => {
    const d = landscape.dataset;
    box.textContent = [
      `${frames.length} fps   worst ${worst.toFixed(0)} ms`,
      `slow (>20 ms) ${slow} of ${total}`,
      `canvas resizes ${d.canvasResizes || 0}`,
      `${d.renderer || '…'} · dpr ${devicePixelRatio} · ${innerWidth}×${innerHeight}`,
      `view ${Math.round(visualViewport?.height || 0)} px tall`,
    ].join('\n');
    worst = 0;
  }, 250);
  // Tap the readout to start counting afresh.
  box.addEventListener('click', () => { slow = 0; total = 0; landscape.dataset.canvasResizes = '0'; });
}

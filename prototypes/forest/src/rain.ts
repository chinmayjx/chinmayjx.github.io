// Night rain: slanted streaks in depth over the forest, angled by the same gusts that
// bend the trees (see the forest shader). Far drops are faint, short and slow.
type Drop = { x: number; y: number; z: number; length: number; speed: number };
type Splash = { x: number; y: number; age: number };

function gust(t: number, x: number) {
  return .55 + .45 * Math.sin(t * .55 - x * .0022) * (.65 + .35 * Math.sin(t * .21 + 1.3));
}

export function startRain(stage: HTMLElement, groundY: () => number) {
  const canvas = document.createElement('canvas');
  canvas.className = 'rain';
  canvas.setAttribute('aria-hidden', 'true');
  stage.querySelector('#landscape')!.after(canvas);
  const context = canvas.getContext('2d')!;
  let drops: Drop[] = [], splashes: Splash[] = [], width = 0, height = 0, last = performance.now();

  function spawn(drop: Partial<Drop> = {}): Drop {
    const z = Math.random() ** 1.6;
    return { x: Math.random() * (width + 200) - 100, y: -Math.random() * height, z,
      length: 10 + 22 * z, speed: 520 + 700 * z, ...drop };
  }
  function resize() {
    const density = Math.min(devicePixelRatio || 1, 2);
    width = stage.clientWidth; height = stage.clientHeight;
    canvas.width = width * density; canvas.height = height * density;
    context.setTransform(density, 0, 0, density, 0, 0);
    drops = Array.from({ length: Math.round(width * height / 900) }, () => spawn({ y: Math.random() * height }));
  }
  new ResizeObserver(resize).observe(stage);

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    const raining = document.documentElement.dataset.theme !== 'light'
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    canvas.style.opacity = raining ? '1' : '0';
    if (!raining || document.hidden) return;
    context.clearRect(0, 0, width, height);
    const slant = .12 + .3 * gust(now / 1000, width * .5);
    const ground = groundY();
    context.lineCap = 'round';
    for (const drop of drops) {
      drop.y += drop.speed * dt;
      drop.x += drop.speed * slant * dt;
      const floor = ground + (1 - drop.z) * -40 + drop.z * 60;
      if (drop.y > floor) {
        if (drop.z > .45 && Math.random() < .5) splashes.push({ x: drop.x, y: floor, age: 0 });
        Object.assign(drop, spawn({ y: -drop.length - Math.random() * 60 }));
        continue;
      }
      context.strokeStyle = `rgba(178, 206, 204, ${.12 + .38 * drop.z})`;
      context.lineWidth = .6 + .9 * drop.z;
      context.beginPath();
      context.moveTo(drop.x, drop.y);
      context.lineTo(drop.x - drop.length * slant, drop.y - drop.length);
      context.stroke();
    }
    splashes = splashes.filter(splash => (splash.age += dt) < .25);
    context.lineWidth = .7;
    for (const splash of splashes) {
      const k = splash.age / .25;
      context.strokeStyle = `rgba(178, 206, 204, ${.35 * (1 - k)})`;
      context.beginPath();
      context.ellipse(splash.x, splash.y, 2 + 6 * k, 1 + 1.5 * k, 0, Math.PI, 2 * Math.PI);
      context.stroke();
    }
  }
  requestAnimationFrame(frame);
}

/** A small, seeded botanical drawing kit. All artwork is generated locally as SVG. */
const PI = Math.PI;
const n = (value: number) => Math.round(value * 10) / 10;
type Random = () => number;
function random(seed: number): Random {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const path = (className: string, d: string) => d ? `<path class="${className}" d="${d}"/>` : '';

// A stroke outline lets branches with different widths share one filled path.
// Sample the original quadratic, including its original tenth-unit rounding.
function strokeOutline(x: number, y: number, cx: number, cy: number, ex: number, ey: number, width: number) {
  [x, y, cx, cy, ex, ey, width] = [x, y, cx, cy, ex, ey, width].map(n);
  const left: string[] = [], right: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, u = 1 - t;
    const px = u * u * x + 2 * u * t * cx + t * t * ex;
    const py = u * u * y + 2 * u * t * cy + t * t * ey;
    const dx = u * (cx - x) + t * (ex - cx), dy = u * (cy - y) + t * (ey - cy);
    const factor = width / (2 * Math.hypot(dx, dy) || 1);
    left.push(`${n(px - dy * factor)} ${n(py + dx * factor)}`);
    right.push(`${n(px + dy * factor)} ${n(py - dx * factor)}`);
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

function leaf(x: number, y: number, length: number, angle: number) {
  const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
  const wx = -dy * .24, wy = dx * .24;
  return `M${n(x)} ${n(y)}q${n(dx * .38 + wx)} ${n(dy * .38 + wy)} ${n(dx)} ${n(dy)}q${n(-dx * .38 - wx * 1.3)} ${n(-dy * .38 - wy * 1.3)} ${n(-dx)} ${n(-dy)}Z`;
}

/** Light falls from the moon / sun, up and to the right. */
const LIGHT = { x: .55, y: -.83 };

/** A scalloped blob: the outline of a mass of leaves seen from a distance. */
function blob(cx: number, cy: number, rx: number, ry: number, rng: Random, lobes = 9, bulge = .32) {
  const points: [number, number][] = [];
  const turn = rng() * PI * 2;
  for (let i = 0; i < lobes; i++) {
    const a = turn + (i + (rng() - .5) * .5) / lobes * PI * 2;
    const r = .82 + rng() * .3;
    points.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  let d = `M${n(points[0][0])} ${n(points[0][1])}`;
  for (let i = 0; i < lobes; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % lobes];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    // Push each segment's middle outward: every lobe reads as a small clump of leaves.
    const ox = mx - cx, oy = my - cy, len = Math.hypot(ox, oy) || 1;
    const push = Math.hypot(x2 - x1, y2 - y1) * (bulge + rng() * .2);
    d += `Q${n(mx + ox / len * push)} ${n(my + oy / len * push)} ${n(x2)} ${n(y2)}`;
  }
  return d + 'Z';
}

/** A tapering branch from (x, y) to (ex, ey), bending through (cx, cy), traced as a smooth
 * outline. `flare` widens the base where it leaves its parent, so a fork grows rather than
 * meets; `lens` makes a shape that is thin at both ends (bark highlights fade into the joints). */
function limb(x: number, y: number, cx: number, cy: number, ex: number, ey: number, w0: number, w1: number, flare = 0, lens = false) {
  const left: string[] = [], right: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, u = 1 - t;
    const px = u * u * x + 2 * u * t * cx + t * t * ex, py = u * u * y + 2 * u * t * cy + t * t * ey;
    const dx = u * (cx - x) + t * (ex - cx), dy = u * (cy - y) + t * (ey - cy);
    const len = Math.hypot(dx, dy) || 1;
    const w = lens ? w0 * Math.sin(PI * t) : w0 + (w1 - w0) * t + flare * w0 * Math.max(0, 1 - t / .22) ** 2;
    left.push(`${n(px - dy / len * w / 2)} ${n(py + dx / len * w / 2)}`);
    right.push(`${n(px + dy / len * w / 2)} ${n(py - dx / len * w / 2)}`);
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

/** A round pad where a branch forks, so the joint has no corners. */
function disc(x: number, y: number, r: number) {
  const k = r * .5523;
  return `M${n(x - r)} ${n(y)}C${n(x - r)} ${n(y - k)} ${n(x - k)} ${n(y - r)} ${n(x)} ${n(y - r)}C${n(x + k)} ${n(y - r)} ${n(x + r)} ${n(y - k)} ${n(x + r)} ${n(y)}C${n(x + r)} ${n(y + k)} ${n(x + k)} ${n(y + r)} ${n(x)} ${n(y + r)}C${n(x - k)} ${n(y + r)} ${n(x - r)} ${n(y + k)} ${n(x - r)} ${n(y)}Z`;
}

type TreeOptions = { seed: number; x: number; y: number; height: number; width: number; kind?: string; fine?: boolean; lean?: number; depth?: number; monochrome?: boolean; bark?: 'all' | 'light' | 'none'; canopy?: boolean };
/**
 * A tree whose canopy is a few solid masses, not loose leaves:
 * - each branch tip ends in a clump: a scalloped mass in three values (shadow, mid, lit)
 *   shifted toward the light, so it reads as a rounded volume;
 * - bigger masses sit behind the clumps, so the canopy has a body;
 * - twigs run into every clump, and some clumps pass behind the branches.
 * Distant trees drop to two values (mid layer) or one (far layer, close silhouettes).
 */
function tree({ seed, x, y, height, width, kind = 'beech', fine = false, lean = 0, depth = 5, monochrome = false, bark = 'all', canopy = true }: TreeOptions) {
  const detail = !monochrome ? 'full' : bark === 'light' ? 'simple' : 'silhouette';
  const rng = random(seed);
  const wood: string[] = [], joints: string[] = [], twigs: string[] = [], highlights: string[] = [];
  const clumps: { x: number; y: number; r: number; depth: number }[] = [], bodies: { x: number; y: number; r: number }[] = [];
  const spread = kind === 'ash' ? .55 : kind === 'birch' ? .34 : .48;
  function branch(bx: number, by: number, length: number, angle: number, thickness: number, level: number) {
    const ex = bx + Math.sin(angle) * length, ey = by - Math.cos(angle) * length;
    const bend = (rng() - .5) * length * .3;
    const cx = bx + (ex - bx) * .45 + Math.cos(angle) * bend, cy = by + (ey - by) * .45 + Math.sin(angle) * bend;
    const end = level <= 1 ? thickness * .35 : thickness * .62;
    wood.push(limb(bx, by, cx, cy, ex, ey, thickness, end, level < depth ? .45 : 0));
    if (level > 0) joints.push(disc(ex, ey, end * .56));
    if (thickness > 9 && bark !== 'none') highlights.push(limb(bx + thickness * .14, by, cx + thickness * .14, cy, ex + end * .14, ey, thickness * .16, 0, 0, true));
    if (level === 2) bodies.push({ x: ex, y: ey - length * .35, r: length * .7 + 24 });
    if (level <= 1) {
      const r = length * .7 + (fine ? 18 : 30);
      clumps.push({ x: ex + Math.sin(angle) * r * .35, y: ey - r * .3, r, depth: rng() });
      // Twigs fan out from the tip into the clump, so the leaves have something to hang from.
      for (let i = 0; i < 3; i++) {
        const a = angle * .5 + (i - 1) * .6 + (rng() - .5) * .3, l = r * (.3 + rng() * .25);
        twigs.push(limb(ex, ey, ex + Math.sin(a) * l * .5, ey - Math.cos(a) * l * .5, ex + Math.sin(a) * l, ey - Math.cos(a) * l, Math.max(1.2, end * .8), .6));
      }
      if (!level) return;
    }
    const left = length * (.62 + rng() * .14), right = length * (.64 + rng() * .16);
    const leftAngle = angle - spread * (.6 + rng() * .8);
    branch(ex, ey, left, leftAngle, thickness * .6, level - 1);
    const rightAngle = angle + spread * (.6 + rng() * .8);
    branch(ex, ey, right, rightAngle, thickness * .66, level - 1);
    // Fill the crotch with a curved web, so the fork is a U that grows apart, not a cut V.
    const reach = end * 1.4, dip = end * .45;
    joints.push(`M${n(ex)} ${n(ey)}L${n(ex + Math.sin(leftAngle) * reach)} ${n(ey - Math.cos(leftAngle) * reach)}Q${n(ex + Math.sin(angle) * dip)} ${n(ey - Math.cos(angle) * dip)} ${n(ex + Math.sin(rightAngle) * reach)} ${n(ey - Math.cos(rightAngle) * reach)}Z`);
    if (level >= 3 && rng() > .3) {
      const side = rng() > .5 ? 1 : -1;
      branch(bx + (ex - bx) * .6, by + (ey - by) * .6, length * .58, angle + side * (.8 + rng() * .3), thickness * .4, level - 2);
    }
  }
  branch(x, y, height * .37, lean, width, depth);
  const roots = depth < 5 ? '' : `M${n(x - width * .46)} ${y - 24}Q${n(x - width * .55)} ${y - 4} ${n(x - width * 1.65)} ${y + 8}Q${n(x - width * .9)} ${y + 6} ${n(x - width * .45)} ${y + 3}L${n(x - width * .6)} ${y + 11}Q${n(x - width * .06)} ${y + 3} ${n(x + width * .17)} ${y + 4}Q${n(x + width * .9)} ${y + 14} ${n(x + width * 1.8)} ${y + 11}Q${n(x + width * .8)} ${y + 1} ${n(x + width * .5)} ${y - 24}Z`;
  let detailMarks = '';
  if (kind === 'birch') {
    for (let i = 0; i < 19; i++) {
      const h = rng() * height * .34;
      const wx = x + Math.sin(lean) * h - width * .37;
      detailMarks += `<path class="birch-mark" d="M${n(wx)} ${n(y - h)}l${n(width * (.15 + rng() * .42))} -1.5" stroke-width="${n(1 + rng() * 3)}"/>`;
    }
  }

  const body: string[] = [];
  const front: string[][] = [[], [], []], back: string[][] = [[], [], []]; // shadow, mid, lit
  if (!canopy) { bodies.length = 0; clumps.length = 0; twigs.length = 0; }
  for (const mass of bodies) body.push(blob(mass.x, mass.y, mass.r, mass.r * .72, rng, 11, .38));
  for (const clump of clumps) {
    const { x: cx, y: cy, r } = clump;
    const into = clump.depth < .3 ? back : front;
    const ry = r * .66;
    into[0].push(blob(cx, cy, r, ry, rng));
    if (detail === 'silhouette') continue;
    into[1].push(blob(cx + LIGHT.x * r * .2, cy + LIGHT.y * ry * .26, r * .74, ry * .66, rng, 8));
    if (detail === 'simple') continue;
    into[2].push(blob(cx + LIGHT.x * r * .42, cy + LIGHT.y * ry * .5, r * .44, ry * .34, rng, 7, .4));
  }
  const tones = (set: string[][], prefix: string) => set.map((d, i) => path(`${prefix}-${i}`, d.join(''))).join('');
  // Roots wind in the opposite direction to branches. Keep their paint separate
  // so nonzero filling cannot punch a hole where trunk and roots overlap.
  return `<g class="tree ${kind}">${tones(back, 'back')}${path('canopy-body', body.join(''))}${path('wood', roots)}${path('wood', wood.join(''))}${path('wood', joints.join(''))}${path('bark-light outline', highlights.join(''))}${detailMarks}${path('twig', twigs.join(''))}${tones(front, 'canopy')}</g>`;
}

function fern(x: number, y: number, size: number, rng: Random, shade = '') {
  let stems = '', leaves = '';
  for (let f = 0; f < 5; f++) {
    const angle = -.95 + f * .47 + (rng() - .5) * .2;
    const length = size * (.65 + rng() * .35);
    const dx = Math.sin(angle) * length;
    const dy = -Math.cos(angle) * length;
    stems += `M${n(x)} ${n(y)}q${n(dx * .18)} ${n(dy * .8)} ${n(dx)} ${n(dy)}`;
    for (let j = 1; j < 10; j++) {
      const t = j / 11;
      const fx = x + dx * t * t;
      const fy = y + dy * (1.6 * t - .6 * t * t);
      const lengthLeaf = Math.sin(t * PI) * size * .22;
      leaves += leaf(fx, fy, lengthLeaf, angle - PI * .95) + leaf(fx, fy, lengthLeaf, angle - PI * .05);
    }
  }
  return `<g class="fern ${shade}"><path d="${stems}" fill="none" stroke="currentColor" stroke-width=".8"/>${path('leaf leaf-0', leaves)}</g>`;
}

function grasses(width: number, seed: number, baseline: number, count: number, tall = false) {
  const rng = random(seed);
  const tones = ['', '', ''];
  let stems = '', seeds = '';
  for (let i = 0; i < count; i++) {
    const x = rng() * width, y = baseline + rng() * 40;
    let blades = '';
    const h = (tall ? 32 : 9) + rng() * (tall ? 55 : 24);
    for (let j = 0; j < 5; j++) {
      const spread = (rng() - .5) * h * 1.5, length = h * (.35 + rng() * .65);
      blades += `M${n(x)} ${n(y)}q${n(spread * .25)} ${n(-length * .8)} ${n(spread)} ${n(-length)}q${n(-spread * .75)} ${n(length * .65)} ${n(-spread)} ${n(length)}Z`;
    }
    tones[i % 3] += blades;
    if (tall && i % 12 === 0) {
      stems += `M${n(x)} ${n(y)}q-4 -35 12 -${n(h + 19)}`;
      for (let k = 0; k < 5; k++) seeds += leaf(x + 8 - k * 2, y - h - 10 + k * 8, 7, -.7);
    }
  }
  return tones.map((d, i) => path(`grass grass-${i}`, d)).join('') + (stems ? `<path class="seed-stem" d="${stems}" fill="none" stroke="currentColor" stroke-width="1"/>` : '') + path('leaf leaf-0', seeds);
}

function rocks(x: number, y: number, size: number) {
  return `<g class="rock"><path d="M${x - size} ${y}l${size * .28} -${size * .46}l${size * .75} -${size * .15}l${size * .7} ${size * .3}l${size * .27} ${size * .39}Z"/><path class="rock-light" d="M${x - size * .72} ${y - size * .46}l${size * .75} -${size * .15}l${size * .7} ${size * .3}l-${size * .91} -.05Z"/></g>`;
}

function layer(name: string, speed: number, width: number, artwork: string) {
  return `<svg class="world-layer ${name}" data-speed="${speed}" data-width="${width}" viewBox="0 0 ${width} 900" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${artwork}</svg>`;
}

export function drawForest(): string {
  const skyRng = random(31);
  let stars = '';
  for (let i = 0; i < 57; i++) stars += `<circle cx="${n(skyRng() * 1440)}" cy="${n(40 + skyRng() * 490)}" r="${n(.4 + skyRng() * .8)}" opacity="${n(.15 + skyRng() * .45)}"/>`;
  const sky = `<div class="sky"></div><svg class="stars" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMin slice">${stars}</svg><div class="moon"><span></span></div><div class="daylight"></div>`;
  const hills = layer('hills', .12, 2700, `<path class="hill-back" d="M0 474Q150 364 400 412T790 385T1210 438T1590 360T2040 390T2700 420V900H0Z"/><path class="hill-front" d="M0 540Q220 420 450 488T960 458T1430 494T1900 435T2360 492T2700 450V900H0Z"/>`);
  let distant = '';
  const farRng = random(90);
  for (let i = 0; i < 51; i++) {
    const x = i * 73 + farRng() * 41, y = 660 + farRng() * 30;
    if (x > 1160 && x < 2000) continue;
    distant += tree({ seed: 90 + i, x, y, height: 210 + farRng() * 230, width: 5 + farRng() * 8, depth: 3, fine: true, monochrome: true, bark: 'none', lean: (farRng() - .5) * .24 });
  }
  const far = layer('far-trees', .26, 3900, distant);
  let middle = '';
  const midRng = random(222);
  const midPositions = [-130, 300, 520, 740, 1220, 1570, 1820, 2040, 2930, 3230, 3520, 3860, 4300, 4710];
  for (const [i, x] of midPositions.entries()) middle += tree({ seed: i * 6 + 88, x, y: 733 + midRng() * 20, height: 470 + midRng() * 260, width: 14 + midRng() * 15, depth: 4, fine: true, monochrome: true, bark: 'light', lean: (midRng() - .5) * .2 });
  const mid = layer('mid-trees', .53, 5000, middle);
  const mist = `<div class="mist mist-back"></div>`;
  let main = `<path class="ground-back" d="M0 773Q190 738 410 763T870 760T1270 769T1660 746T2090 766T2570 758T3060 770T3510 750T3950 771T4470 758T5200 770V900H0Z"/>`;
  const trees: TreeOptions[] = [
    { seed: 422, x: -85, y: 791, height: 1080, width: 76, lean: .1 },
    { seed: 37, x: 920, y: 780, height: 940, width: 61, lean: -.13 },
    { seed: 69, x: 1860, y: 776, height: 1000, width: 52, lean: .16, kind: 'ash' },
    { seed: 88, x: 2950, y: 782, height: 1020, width: 39, lean: -.12, kind: 'birch', fine: true },
    { seed: 125, x: 3000, y: 782, height: 850, width: 23, lean: .1, kind: 'birch', fine: true },
    { seed: 72, x: 4730, y: 780, height: 1090, width: 69, lean: -.1 },
  ];
  trees.forEach(options => { main += tree(options); });
  main += rocks(1950, 788, 52) + rocks(2750, 797, 29) + rocks(499, 785, 27) + rocks(4300, 795, 35);
  main += `<path class="ground-front" d="M0 804Q220 779 460 802T960 797T1490 804T1950 800T2400 806T2900 795T3410 807T3890 798T4460 809T5200 798V900H0Z"/><path class="path-edge" d="M0 810Q360 790 650 813T1270 815T1900 812T2520 822T3160 818T3780 824T4420 817T5200 822" fill="none" stroke-width="1.1"/>`;
  main += `<path class="path-ribbon" d="M0 836Q280 819 560 836T1210 831T1790 838T2410 835T3020 839T3690 836T4350 831T5200 839L5200 852Q4760 840 4350 849T3690 853T3020 856T2410 851T1790 856T1210 849T560 852T0 851Z"/>`;
  main += grasses(5200, 44, 788, 230);
  const plantsRng = random(46);
  for (const x of [40, 120, 310, 780, 874, 1280, 1500, 1780, 2010, 2370, 2830, 2970, 3340, 3640, 3900, 4030, 4320, 4490, 4790, 4880]) main += fern(x, 805 + plantsRng() * 6, 28 + plantsRng() * 29, plantsRng, 'ground-fern');
  for (const x of [3950, 3972, 3990, 4260, 4283, 4290]) {
    const y = 789, h = 19 + plantsRng() * 19;
    main += `<path class="flower-stem" d="M${x} ${y}q-5 -${n(h * .6)} 1 -${n(h)}" fill="none" stroke-width=".8"/><g class="flower"><ellipse cx="${x + 1}" cy="${n(y - h)}" rx="3" ry="1.3"/><ellipse cx="${x + 1}" cy="${n(y - h)}" rx="1.1" ry="3"/></g>`;
  }
  // Fallen twigs, small stones and leaf litter give the path a human scale.
  const litter = new Map<number, string>();
  for (let i = 0; i < 120; i++) {
    const x = plantsRng() * 5200, y = 818 + plantsRng() * 40;
    const d = `M${n(x)} ${n(y)}l${n(3 + plantsRng() * 10)} -${n(plantsRng() * 2)}`;
    const width = n(.5 + plantsRng());
    litter.set(width, (litter.get(width) || '') + d);
  }
  for (const [width, d] of litter) main += `<path class="path-detail" d="${d}" stroke-width="${width}"/>`;
  const forest = layer('feature-trees', 1, 5200, main);
  let close = `<path class="near-ground" d="M0 883Q200 855 440 876T950 880T1530 872T2010 885T2600 872T3130 880T3700 877T4200 881T4800 873T5400 885T6200 870V900H0Z"/>`;
  close += grasses(6500, 78, 886, 210, true);
  const fernRng = random(28);
  for (const x of [48, 160, 680, 1200, 1310, 1680, 2200, 2370, 2740, 3270, 3480, 3890, 4440, 4610, 4890, 5290, 5630, 6110]) close += fern(x, 901, 58 + fernRng() * 62, fernRng);
  // A few close trunks frame the walk without obscuring a signpost; their crowns are
  // above the view, so they stay bare rather than hang a dark mass over the scene.
  close += tree({ canopy: false, seed: 76, x: -165, y: 922, height: 1380, width: 98, lean: .08, depth: 4, monochrome: true });
  close += tree({ canopy: false, seed: 91, x: 2180, y: 922, height: 1350, width: 71, lean: -.07, depth: 4, monochrome: true });
  close += tree({ canopy: false, seed: 121, x: 5800, y: 922, height: 1350, width: 85, lean: .05, depth: 4, monochrome: true });
  const foreground = layer('foreground', 1.22, 6500, close);
  let flies = '';
  const flyRng = random(12);
  for (let i = 0; i < 18; i++) flies += `<i class="firefly" style="left:${n(150 + flyRng() * 4700)}px;top:${n(480 + flyRng() * 270)}px;--delay:-${n(flyRng() * 13)}s;--duration:${n(6 + flyRng() * 5)}s"></i>`;
  return `${sky}${hills}${far}${mid}${mist}${forest}<div class="world-layer fireflies" data-speed=".85" data-width="5200">${flies}</div>${foreground}<div class="vignette"></div>`;
}

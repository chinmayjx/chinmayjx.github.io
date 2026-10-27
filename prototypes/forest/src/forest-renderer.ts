import { paintTile, prepareScene } from './forest-painter';
import type { Bounds, Drawing, PreparedScene, Scene, TileRequest, TileResult, WorkerRequest } from './forest-painter';

type Layer = {
  source: SVGSVGElement; host: HTMLDivElement; speed: number; worldWidth: number; dpr: number;
  tiles: Map<number, HTMLCanvasElement>; visible: number[]; wanted: number[];
};

function bounds(node: SVGGraphicsElement): Bounds {
  const b = node.getBBox();
  // Include the thin strokes in rejection bounds.
  return { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 };
}

/** Resolve the existing SVG CSS once per palette, never during scrolling. */
function drawing(node: SVGGraphicsElement): Drawing[] {
  const style = getComputedStyle(node);
  if (style.display === 'none') return [];
  const opacity = Number(style.opacity);
  if (node.tagName.toLowerCase() === 'g') {
    const children = [...node.children].flatMap(child => drawing(child as SVGGraphicsElement));
    return opacity === 1 ? children : [{ children, opacity, bounds: bounds(node) }];
  }
  let d = node.getAttribute('d') || '';
  if (node instanceof SVGEllipseElement) {
    const x = node.cx.baseVal.value, y = node.cy.baseVal.value;
    const rx = node.rx.baseVal.value, ry = node.ry.baseVal.value;
    d = `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
  }
  return [{
    bounds: bounds(node), opacity, d, fill: style.fill, stroke: style.stroke,
    lineWidth: parseFloat(style.strokeWidth), lineCap: style.strokeLinecap as CanvasLineCap,
    lineJoin: style.strokeLinejoin as CanvasLineJoin, fillRule: style.fillRule as CanvasFillRule,
  }];
}

export class ForestRenderer {
  private layers: Layer[];
  private worker?: Worker;
  private scenes: Scene[] = [];
  private fallback?: PreparedScene[];
  private generation = 0;
  private busy = false;
  private width = 0;
  private height = 0;
  private unit = 1;
  private offset = 0;
  private direction = 1;
  private reduced = false;
  private peakBytes = 0;

  constructor(private landscape: HTMLElement) {
    this.layers = [...landscape.querySelectorAll<SVGSVGElement>('svg.world-layer')].map(source => {
      const host = document.createElement('div');
      host.className = `${source.getAttribute('class')} raster-layer`;
      host.setAttribute('aria-hidden', 'true');
      source.classList.add('geometry-source');
      source.before(host);
      return {
        source, host, speed: Number(source.dataset.speed), worldWidth: Number(source.dataset.width),
        dpr: source.classList.contains('hills') || source.classList.contains('far-trees') ? 1
          : source.classList.contains('mid-trees') ? 1.5 : 2,
        tiles: new Map(), visible: [], wanted: [],
      };
    });
    if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./forest-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<TileResult>) => {
        this.busy = false;
        const { tile, bitmap } = data;
        const layer = this.layers[tile.layer];
        if (tile.generation === this.generation && layer.wanted.includes(tile.index)) {
          const canvas = this.makeCanvas(tile);
          const context = canvas.getContext('bitmaprenderer');
          if (context) context.transferFromImageBitmap(bitmap);
          else { canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close(); }
          this.accept(layer, tile, canvas);
        } else bitmap.close();
        this.pump();
      };
      this.worker.onerror = () => {
        this.worker?.terminate(); this.worker = undefined;
        this.fallback = this.scenes.map(prepareScene);
        this.busy = false;
        this.pump();
      };
    }
    this.landscape.dataset.geometryElements = `${this.layers.reduce((sum, layer) => sum + layer.source.querySelectorAll('*').length, 0)}`;
  }

  resize(width: number, height: number, unit: number, reduced: boolean) {
    this.width = width; this.height = height; this.unit = unit; this.reduced = reduced;
    for (const { source, worldWidth, host } of this.layers) {
      source.style.width = `${worldWidth * unit}px`;
      host.style.width = `${width}px`;
    }
    this.recolor();
  }

  recolor() {
    if (!this.width) return;
    this.generation++;
    this.scenes = this.layers.map(layer => {
      const { source, host } = layer;
      // Keep source geometry detached between palette changes; it never paints.
      host.after(source);
      const drawings = [...source.children].flatMap(child => drawing(child as SVGGraphicsElement));
      const opacity = Number(getComputedStyle(source).opacity);
      source.remove();
      const fade: [number, number][] = source.classList.contains('far-trees')
        ? [[0, 1], [.4, 1], [.62, .6], [.81, 0], [1, 0]]
        : source.classList.contains('mid-trees') ? [[0, 1], [.62, 1], [.78, .6], [.88, 0], [1, 0]] : [];
      return { drawings, opacity, fade };
    });
    if (this.worker) this.send({ type: 'scene', scenes: this.scenes });
    else this.fallback = this.scenes.map(prepareScene);
    for (const layer of this.layers) this.clear(layer);
    this.render(this.offset);
  }

  render(offset: number) {
    if (!this.width) return;
    if (offset !== this.offset) this.direction = offset > this.offset ? 1 : -1;
    this.offset = this.reduced ? 0 : offset;
    for (const layer of this.layers) {
      if (this.reduced && (layer.source.classList.contains('feature-trees') || layer.source.classList.contains('foreground'))) {
        layer.visible = layer.wanted = [];
        continue;
      }
      const camera = this.offset * layer.speed;
      const first = Math.floor(camera / this.width);
      const last = Math.ceil((camera + this.width) / this.width) - 1;
      layer.visible = first === last ? [first] : [first, last];
      // At most two visible tiles, one ahead and one behind. Never the whole walk.
      layer.wanted = [...new Set([...layer.visible, last + 1, first - 1])].filter(index => index >= 0);
      for (const [index, canvas] of layer.tiles) {
        if (!layer.wanted.includes(index)) {
          canvas.remove(); canvas.width = canvas.height = 0; layer.tiles.delete(index);
        } else this.position(layer, index, canvas);
      }
    }
    this.pump();
  }

  private position(layer: Layer, index: number, canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round((index * this.width - this.offset * layer.speed) * dpr) / dpr;
    canvas.style.transform = `translate3d(${x}px,0,0)`;
  }

  private makeCanvas(tile: TileRequest) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(tile.width * tile.dpr); canvas.height = Math.ceil(tile.height * tile.dpr);
    canvas.style.width = `${tile.width}px`; canvas.style.height = `${tile.height}px`;
    return canvas;
  }

  private accept(layer: Layer, tile: TileRequest, canvas: HTMLCanvasElement) {
    layer.tiles.set(tile.index, canvas);
    this.position(layer, tile.index, canvas);
    layer.host.append(canvas);
    this.report();
  }

  private report() {
    const bytes = this.layers.reduce((sum, layer) => sum + [...layer.tiles.values()].reduce((n, c) => n + c.width * c.height * 4, 0), 0);
    this.peakBytes = Math.max(this.peakBytes, bytes);
    this.landscape.dataset.canvasMb = (bytes / 1024 ** 2).toFixed(2);
    this.landscape.dataset.peakCanvasMb = (this.peakBytes / 1024 ** 2).toFixed(2);
    this.landscape.dataset.forestReady = `${this.layers.every(layer => layer.visible.every(index => layer.tiles.has(index)))}`;
  }

  private pump() {
    this.report();
    if (this.busy) return;
    for (const visibleOnly of [true, false]) {
      for (const [layerIndex, layer] of this.layers.entries()) {
        const candidates = visibleOnly ? layer.visible : [...layer.wanted].sort((a, b) => this.direction * (b - a));
        const index = candidates.find(i => !layer.tiles.has(i));
        if (index === undefined) continue;
        // Keep a four-tile-per-layer cache below 48 MiB even on large displays.
        const nativeDpr = window.devicePixelRatio || 1;
        const density = this.layers.reduce((sum, l) => sum + Math.min(nativeDpr, l.dpr) ** 2, 0);
        const budgetScale = Math.min(1, Math.sqrt(48 * 1024 ** 2 / (4 * this.width * this.height * 4 * density)));
        const dpr = Math.min(nativeDpr, layer.dpr) * budgetScale;
        const scale = Math.min(this.unit, this.height / 900);
        const tile: TileRequest = {
          generation: this.generation, layer: layerIndex, index,
          width: this.width, height: this.height, dpr, scale,
          shiftX: layer.worldWidth * (this.unit - scale) / 2, shiftY: (this.height - 900 * scale) / 2,
        };
        this.busy = true;
        if (this.worker) this.send({ type: 'tile', tile });
        else setTimeout(() => {
          if (tile.generation === this.generation && layer.wanted.includes(index)) {
            const canvas = this.makeCanvas(tile);
            paintTile(canvas.getContext('2d')!, this.fallback![layerIndex], tile);
            this.accept(layer, tile, canvas);
          }
          this.busy = false; this.pump();
        }, 0);
        return;
      }
    }
  }

  private send(message: WorkerRequest) { this.worker!.postMessage(message); }

  private clear(layer: Layer) {
    for (const canvas of layer.tiles.values()) { canvas.remove(); canvas.width = canvas.height = 0; }
    layer.tiles.clear();
  }
}

import {
  Buffer, BufferUsage, Color, Container, Geometry, GlProgram,
  GraphicsContext, GraphicsContextSystem, GraphicsPath, Mesh, RenderContainer, Shader, WebGLRenderer, extensions,
} from 'pixi.js';
import { ForestFireflies } from './forest-fireflies';

// We use the compiler without importing Graphics. Register its system explicitly
// so production tree shaking cannot discard the Graphics module's side effect.
extensions.add(GraphicsContextSystem);

// Only positions and packed colours survive compilation. No leaf textures, SVG
// nodes in the live tree, ticker, interaction system, or per-frame tessellation.
const vertex = `
in vec2 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec4 vColor;
out float vY;
void main() {
  vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vColor = aColor;
  vY = (uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).y;
}`;
const fragment = `
in vec4 vColor;
in float vY;
uniform vec4 uFade;
uniform float uHeight;
uniform float uViewY;
out vec4 finalColor;
void main() {
  float y = (vY + uViewY) / uHeight;
  float fade = 1.0 - .4 * clamp((y-uFade.x)/(uFade.y-uFade.x),0.0,1.0)
    - .6 * clamp((y-uFade.y)/(uFade.z-uFade.y),0.0,1.0);
  float a = vColor.a * fade * uFade.w;
  finalColor = vec4(vColor.rgb * a, a);
}`;

function makeShader(fade: number[]) {
  return new Shader({ glProgram: GlProgram.from({ vertex, fragment, name: 'forest-vector' }),
    resources: { forest: { uFade: { value: new Float32Array(fade), type: 'vec4<f32>' }, uHeight: { value: 900, type: 'f32' }, uViewY: { value: 0, type: 'f32' } } } });
}

/** Front-to-back coverage gives an isolated opaque layer a single alpha/fade
 * per sample, without allocating a viewport-sized render texture. MSAA stencil
 * samples retain edge coverage. No Pixi masks/filters share this stencil scope.
 */
let coverageSequence = 0;
function coverage(renderer: WebGLRenderer, content: Container): Container {
  const reference = ++coverageSequence;
  if (reference > 255) throw new Error('Forest exceeds the stencil coverage budget');
  const scope = new Container();
  scope.addChild(new RenderContainer(() => {
    const gl = renderer.gl;
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(255);
    gl.stencilFunc(gl.NOTEQUAL, reference, 255);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  }));
  scope.addChild(content);
  scope.addChild(new RenderContainer(() => {
    renderer.gl.disable(renderer.gl.STENCIL_TEST);
    renderer.stencil.resetState();
  }));
  return scope;
}

interface Paint { node: SVGElement; kind: 'fill' | 'stroke'; start: number; end: number; alpha: number; under?: string }
interface Batch { mesh: Mesh<Geometry, Shader>; view: Container; colors: Uint32Array; paints: Paint[]; minX: number; maxX: number }
interface Layer { source: SVGSVGElement; container: Container; speed: number; width: number; batches: Batch[]; shader: Shader; covered: boolean }
/** A layer child (a tree, the ground, a grass band) waiting to be tessellated into its group. */
interface Slot { layer: Layer; child: SVGElement; group: Container; reverse: boolean; minX: number; maxX: number }
/** What the page shows at load: the scroll offset and the stage size, when known. */
export type View = { offset: number; size?: [number, number, number, boolean] };

/** SVG → immutable mesh compiler. Pixi 8.22's tessellator also handles round strokes.
 * updateGpuContext is the single internal API used here; keep its adapter here
 * when upgrading Pixi. Temporary paths and its CPU batch data are destroyed.
 */
function compile(renderer: WebGLRenderer, nodes: SVGElement[], shader: Shader, reverse: boolean): Batch[] {
  const positions: number[] = [], indices: number[] = [], paints: Paint[] = [];
  let minX = Infinity, maxX = -Infinity;
  function visit(node: SVGElement, alpha: number) {
    const style = getComputedStyle(node);
    if (style.display === 'none') return;
    alpha *= Number(style.opacity);
    if (node.tagName.toLowerCase() === 'g') {
      [...node.children].forEach(child => visit(child as SVGElement, alpha));
      return;
    }
    const path = node instanceof SVGEllipseElement
      ? new GraphicsPath().ellipse(node.cx.baseVal.value, node.cy.baseVal.value, node.rx.baseVal.value, node.ry.baseVal.value)
      : new GraphicsPath(node.getAttribute('d') || '');
    // All compound leaves/branches wind alike. Pixi's optional containment-hole
    // heuristic would incorrectly turn contained leaves into holes.
    path.checkForHoles = false;
    for (const kind of ['fill', 'stroke'] as const) {
      if (style[kind] === 'none') continue;
      const context = new GraphicsContext();
      context.path(path);
      if (kind === 'fill') context.fill(0xffffff);
      else context.stroke({ color: 0xffffff, width: parseFloat(style.strokeWidth),
        cap: style.strokeLinecap as 'butt' | 'round' | 'square',
        join: style.strokeLinejoin as 'miter' | 'round' | 'bevel' });
      const data = renderer.graphicsContext.updateGpuContext(context).geometryData;
      const start = positions.length / 2;
      for (let i = 0; i < data.vertices.length; i += 2) {
        const x = data.vertices[i];
        positions.push(x, data.vertices[i + 1]);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
      for (const index of data.indices) indices.push(start + index);
      const wood = reverse && alpha !== 1 ? node.closest('.tree')?.querySelector('.wood') : null;
      paints.push({ node, kind, start, end: positions.length / 2, alpha,
        under: wood ? getComputedStyle(wood).fill : undefined });
      context.destroy();
    }
  }
  nodes.forEach(node => visit(node, 1));
  if (!indices.length) return [];
  if (reverse) {
    // Reverse triangles, preserving each triangle's winding and vertex data.
    for (let a = 0, b = indices.length - 3; a < b; a += 3, b -= 3) {
      for (let k = 0; k < 3; k++) [indices[a+k], indices[b+k]] = [indices[b+k], indices[a+k]];
    }
  }
  const colors = new Uint32Array(positions.length / 2);
  const colorBuffer = new Buffer({ data: colors, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  const positionBuffer = new Buffer({ data: new Float32Array(positions), usage: BufferUsage.VERTEX });
  const attributes = {
    aPosition: { buffer: positionBuffer, format: 'float32x2' as const },
    aColor: { buffer: colorBuffer, format: 'unorm8x4' as const },
  };
  const bins = new Map<number, number[]>();
  const split = maxX - minX > 700;
  const binWidth = 384;
  for (let i = 0; i < indices.length; i += 3) {
    const xs = [positions[indices[i]*2], positions[indices[i+1]*2], positions[indices[i+2]*2]];
    const first = split ? Math.floor(Math.min(...xs) / binWidth) : 0;
    const last = split ? Math.floor(Math.max(...xs) / binWidth) : 0;
    for (let bin = first; bin <= last; bin++) {
      let list = bins.get(bin);
      if (!list) { list = []; bins.set(bin, list); }
      list.push(indices[i], indices[i+1], indices[i+2]);
    }
  }
  // Shared vertex/colour buffers, short per-strip index lists. Triangles crossing
  // a strip edge appear in both lists; a pixel-aligned scissor partitions them
  // without duplicate blending or seams. Scroll never uploads a buffer.
  return [...bins].map(([bin, list]) => {
    const geometry = new Geometry({ attributes,
      indexBuffer: positions.length / 2 > 65535 ? new Uint32Array(list) : new Uint16Array(list),
    });
    const mesh = new Mesh({ geometry, shader });
    const left = split ? bin * binWidth : minX;
    const right = split ? left + binWidth : maxX;
    let view: Container = mesh;
    if (split) {
      view = new Container();
      view.addChild(new RenderContainer(() => {
        const gl = renderer.gl, matrix = mesh.worldTransform, density = renderer.resolution;
        const x = Math.max(0, Math.round((left * matrix.a + matrix.tx) * density));
        const end = Math.min(renderer.canvas.width, Math.round((right * matrix.a + matrix.tx) * density));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x, 0, Math.max(0, end - x), renderer.canvas.height);
      }));
      view.addChild(mesh);
      view.addChild(new RenderContainer(() => renderer.gl.disable(renderer.gl.SCISSOR_TEST)));
    }
    return { mesh, view, colors, paints, minX: left, maxX: right };
  });
}

export class WebGLForest {
  private renderer = new WebGLRenderer();
  private root = new Container();
  private layers: Layer[] = [];
  private canvas = document.createElement('canvas');
  private width = 0;
  private height = 0;
  private unit = 1;
  private offset = 0;
  private reduced = false;
  private resolution = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private flies?: ForestFireflies;
  private destroyed = false;
  private lastView = '';
  private lastRender = 0;
  private geometryBytes = 0;
  private triangles = 0;
  private mist?: Mesh<Geometry, Shader>;
  private pending: Slot[] = [];

  constructor(private landscape: HTMLElement, private onFailure: (error: unknown) => void, private requestFrame: () => void) {}

  async init(view: () => View = () => ({ offset: 0 })) {
    const initStart = performance.now();
    this.canvas.className = 'forest-webgl';
    this.canvas.setAttribute('aria-hidden', 'true');
    // Pixi's default context leaves the WebGL depth attachment enabled. This
    // strictly 2D renderer needs only colour and stencil, never a depth buffer.
    const attributes: WebGLContextAttributes = { alpha: true, antialias: true,
      depth: false, stencil: true, premultipliedAlpha: true, powerPreference: 'low-power' };
    const context = this.canvas.getContext('webgl2', attributes)
      || this.canvas.getContext('webgl', attributes);
    if (!context) throw new Error('WebGL unavailable');
    await this.renderer.init({ canvas: this.canvas, context: context as WebGL2RenderingContext, width: 1, height: 1,
      resolution: devicePixelRatio || 1, autoDensity: true, antialias: true,
      backgroundAlpha: 0, manageImports: false,
      bezierSmoothness: .8, powerPreference: 'low-power' });
    if (this.destroyed) { this.renderer.destroy(); return; }
    if (this.renderer.context.webGLVersion === 1 && !context.getExtension('OES_element_index_uint')) {
      throw new Error('WebGL cannot address the forest index buffers');
    }
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    coverageSequence = 0;
    this.root.addChild(new RenderContainer(() => {
      const gl = this.renderer.gl;
      gl.stencilMask(255); gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
    }));
    const compileStart = performance.now();
    const sources = [...this.landscape.querySelectorAll<SVGSVGElement>('svg.world-layer')];
    const slots: Slot[] = [];
    for (const source of sources) {
      source.classList.add('geometry-source');
      const container = new Container({ label: source.classList[1] });
      const covered = source.matches('.hills, .far-trees, .mid-trees');
      const fade = source.matches('.far-trees') ? [.4, .62, .81, .7]
        : source.matches('.mid-trees') ? [.62, .78, .88, 1]
        : source.matches('.hills') ? [2, 3, 4, .8] : [2, 3, 4, 1];
      const shader = makeShader(fade);
      const layer: Layer = { source, container, shader, covered, speed: Number(source.dataset.speed), width: Number(source.dataset.width), batches: [] };
      // One mesh per tree / ground drawing: enables coarse view culling, while
      // every leaf in each tree is batched in original paint order and tone.
      // Each drawing gets its group now, in paint order; its meshes come later.
      for (const child of (covered ? [...source.children].reverse() : [...source.children])) {
        const isolated = !covered && Number(getComputedStyle(child).opacity) !== 1;
        const group = new Container();
        const box = (child as SVGGraphicsElement).getBBox();
        slots.push({ layer, child: child as SVGElement, group, reverse: covered || isolated, minX: box.x, maxX: box.x + box.width });
        container.addChild(isolated ? coverage(this.renderer, group) : group);
      }
      this.layers.push(layer);
      this.root.addChild(covered ? coverage(this.renderer, container) : container);
      if (source.matches('.mid-trees')) this.addMist();
      if (source.matches('.feature-trees')) {
        this.flies = new ForestFireflies(this.landscape.querySelector('.fireflies')!);
        this.root.addChild(this.flies.container);
      }
    }
    // Tessellate what the first frame shows now and the rest in short slices after,
    // nearest first, so the forest appears without waiting for every tree in the walk.
    const { offset, size } = view();
    const [width, height, unit] = size || [innerWidth, innerHeight, innerHeight / 900];
    for (const slot of slots) {
      if (this.distance(slot, offset, width, height, unit) === 0) this.compileSlot(slot);
      else this.pending.push(slot);
    }
    this.recolor();
    // Analytic atmospheric effects retain the original HTML paint order.
    this.landscape.querySelector('.vignette')!.before(this.canvas);
    this.landscape.classList.add('webgl-active');
    this.updateStats();
    Object.assign(this.landscape.dataset, {
      renderer: 'webgl',
      webglVersion: `${this.renderer.context.webGLVersion}`,
      antialias: `${this.renderer.gl.getContextAttributes()?.antialias}`,
      samples: `${context.getParameter(context.SAMPLES)}`,
      stencilBits: `${context.getParameter(context.STENCIL_BITS)}`,
      depthBits: `${context.getParameter(context.DEPTH_BITS)}`,
      initStartMs: initStart.toFixed(0), contextMs: (compileStart - initStart).toFixed(0),
      compileMs: (performance.now() - compileStart).toFixed(0),
    });
    this.scheduleIdle();
  }

  private compileSlot(slot: Slot) {
    for (const batch of compile(this.renderer, [slot.child], slot.layer.shader, slot.reverse)) {
      slot.layer.batches.push(batch);
      slot.group.addChild(batch.view);
      this.triangles += batch.mesh.geometry.indexBuffer.data.length / 3;
    }
  }

  /** How far a drawing is from the view, in screens; 0 when it is (nearly) on screen. */
  private distance(slot: Slot, offset: number, width: number, height: number, unit: number) {
    const scale = Math.min(unit, height / 900);
    const shift = slot.layer.width * (unit - scale) / 2 - offset * slot.layer.speed;
    const left = -shift / scale, right = (width - shift) / scale, margin = 200;
    const gap = Math.max(0, slot.minX - (right + margin), (left - margin) - slot.maxX);
    return gap * scale / width;
  }

  /** Tessellates pending drawings in the given order until the deadline, and colours their meshes. */
  private compilePending(slots: Slot[], until = Infinity) {
    if (!slots.length) return;
    const before = new Map(this.layers.map(layer => [layer, layer.batches.length]));
    for (const slot of slots) {
      this.pending.splice(this.pending.indexOf(slot), 1);
      this.compileSlot(slot);
      if (performance.now() >= until) break;
    }
    this.color(this.layers.flatMap(layer => layer.batches.slice(before.get(layer))));
    if (!this.pending.length) {
      this.updateStats();
      this.landscape.dataset.completeMs = performance.now().toFixed(1);
    }
  }

  /** Works through the remaining drawings in ~8 ms slices between frames, nearest first. */
  private scheduleIdle() {
    if (!this.pending.length || this.destroyed) return;
    setTimeout(() => {
      if (this.destroyed || !this.pending.length) return;
      const { width, height, unit } = this;
      const offset = this.offset;
      const order = width
        ? [...this.pending].sort((a, b) => this.distance(a, offset, width, height, unit) - this.distance(b, offset, width, height, unit))
        : [...this.pending];
      // Off-screen work: nothing new to draw, so no frame is requested.
      this.compilePending(order, performance.now() + 8);
      this.scheduleIdle();
    }, 0);
  }

  private updateStats() {
    const buffers = new Set(this.layers.flatMap(l => l.batches.flatMap(b => b.mesh.geometry.buffers)));
    this.geometryBytes = [...buffers].reduce((sum, buffer) => sum + buffer.data.byteLength, 0);
    Object.assign(this.landscape.dataset, {
      triangles: `${this.triangles}`, meshes: `${this.layers.reduce((n, l) => n + l.batches.length, 0)}`,
      geometryMb: (this.geometryBytes / 1024 ** 2).toFixed(2),
    });
  }

  private addMist() {
    const shader = new Shader({
      glProgram: GlProgram.from({ vertex: vertex.replace('in vec4 aColor;', '').replace('out vec4 vColor;', 'out vec2 vPosition;').replace('vColor = aColor;', 'vPosition = aPosition;'),
        fragment: `in vec2 vPosition; uniform vec4 uMist; out vec4 finalColor;
        void main() {
          float r = length((vPosition - vec2(.5,.55)) / vec2(.70710678,.77781746));
          float a = max(0.0, 1.0 - r/.68) * uMist.a;
          finalColor = vec4(uMist.rgb*a,a);
        }`, name: 'forest-mist' }),
      resources: { forest: { uMist: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' } } },
    });
    this.mist = new Mesh({ shader, geometry: new Geometry({ attributes: { aPosition: { buffer: new Float32Array([0,0,1,0,1,1,0,1]), format: 'float32x2' } }, indexBuffer: new Uint16Array([0,1,2,0,2,3]) }) });
    this.root.addChild(this.mist);
  }

  resize(width: number, height: number, unit: number, reduced: boolean) {
    this.width = width; this.height = height; this.unit = unit; this.reduced = reduced;
    const scale = Math.min(unit, height / 900);
    for (const layer of this.layers) {
      layer.container.scale.set(scale);
      layer.container.y = (height - 900 * scale) / 2;
      layer.shader.resources.forest.uniforms.uHeight = height;
    }
    if (this.mist) {
      this.mist.position.set(-.2 * width, .59 * height);
      this.mist.scale.set(1.4 * width, .25 * height);
      this.mist.visible = !reduced;
    }
    this.render(this.offset);
  }

  recolor() {
    this.color(this.layers.flatMap(layer => layer.batches));
    if (this.mist) {
      const css = getComputedStyle(document.documentElement);
      const c = new Color(css.getPropertyValue('--mist').trim()).toArray();
      this.mist.shader!.resources.forest.uniforms.uMist.set([c[0], c[1], c[2], .11 * (matchMedia('(prefers-color-scheme: light)').matches ? .95 : .8)]);
    }
    if (this.width) this.render(this.offset);
  }

  /** Writes each paint's current CSS colour into its batch's colour buffer. */
  private color(batches: Batch[]) {
    const color = new Color();
    const updated = new Set<Uint32Array>();
    // Computed styles need the sources in the document; they leave once all are tessellated.
    for (const layer of this.layers) if (!layer.source.isConnected) this.landscape.append(layer.source);
    for (const batch of batches) {
      if (updated.has(batch.colors)) continue;
      updated.add(batch.colors);
      for (const paint of batch.paints) {
        const style = getComputedStyle(paint.node);
        let rgb = color.setValue(style[paint.kind]).toNumber();
        let opacity = paint.alpha;
        if (paint.under) {
          // Mid-tree highlights lie inside their opaque branch. Precompose
          // those colours so the layer remains one opaque coverage surface.
          const wood = paint.node.closest('.tree')!.querySelector('.wood')!;
          const under = color.setValue(getComputedStyle(wood).fill).toNumber();
          let mixed = 0;
          for (const shift of [0, 8, 16]) mixed |= Math.round(((rgb >>> shift) & 255) * opacity + ((under >>> shift) & 255) * (1-opacity)) << shift;
          rgb = mixed; opacity = 1;
        }
        const alpha = Math.round(255 * opacity);
        const packed = ((alpha << 24) | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >>> 16)) >>> 0;
        batch.colors.fill(packed, paint.start, paint.end);
      }
      batch.mesh.geometry.getBuffer('aColor').update();
    }
    if (!this.pending.length) this.layers.forEach(layer => layer.source.remove());
  }

  render(offset: number) {
    if (this.destroyed || !this.width) return;
    this.offset = this.reduced ? 0 : offset;
    // While the view is still, only the fireflies move: they drift slowly, so 30 fps
    // is plenty and spares the battery. Scrolling and resizing still draw every frame.
    const vv = window.visualViewport;
    const key = `${this.offset} ${this.width} ${this.height} ${devicePixelRatio} ${vv?.scale} ${vv?.offsetLeft} ${vv?.offsetTop} ${vv?.width} ${vv?.height}`;
    const now = performance.now();
    if (key === this.lastView && now - this.lastRender < 30) { this.requestFrame(); return; }
    this.lastView = key; this.lastRender = now;
    // Render only the visible part of a pinched viewport at native pixel density.
    // Cropping keeps the backing store bounded instead of scaling its area by zoom².
    const viewport = window.visualViewport;
    const zoom = Math.max(1, viewport?.scale || 1);
    const viewX = zoom > 1 ? viewport?.offsetLeft || 0 : 0;
    const viewY = zoom > 1 ? viewport?.offsetTop || 0 : 0;
    const viewWidth = Math.min(this.width, viewport?.width || this.width);
    const viewHeight = Math.min(this.height, viewport?.height || this.height);
    const resolution = (devicePixelRatio || 1) * zoom;
    if (resolution !== this.resolution || viewWidth !== this.viewWidth || viewHeight !== this.viewHeight) {
      this.renderer.resize(viewWidth, viewHeight, resolution);
      this.resolution = resolution; this.viewWidth = viewWidth; this.viewHeight = viewHeight;
    }
    this.canvas.style.left = `${viewX}px`; this.canvas.style.top = `${viewY}px`;
    this.root.position.set(-viewX, -viewY);
    const scale = Math.min(this.unit, this.height / 900);
    // A fast scroll can outrun the background slices: never show a gap.
    if (this.pending.length) this.compilePending(this.pending.filter(slot => this.distance(slot, this.offset, this.width, this.height, this.unit) === 0));
    const flies = this.flies?.update(this.offset, viewX, viewY, viewWidth, viewHeight, resolution,
      !this.reduced && !matchMedia('(prefers-color-scheme: light)').matches);
    let calls = (this.mist?.visible ? 1 : 0) + (flies?.count || 0), triangles = calls * 2;
    for (const layer of this.layers) {
      layer.container.visible = !this.reduced || !layer.source.matches('.feature-trees, .foreground');
      layer.container.x = layer.width * (this.unit - scale) / 2 - this.offset * layer.speed;
      layer.shader.resources.forest.uniforms.uViewY = viewY;
      const left = (viewX - layer.container.x) / scale, right = left + viewWidth / scale;
      for (const batch of layer.batches) {
        batch.view.visible = batch.maxX >= left && batch.minX <= right;
        if (batch.view.visible && layer.container.visible) {
          calls++; triangles += batch.mesh.geometry.indexBuffer.data.length / 3;
        }
      }
    }
    try { this.renderer.render(this.root); }
    catch (error) { this.onFailure(error); return; }
    Object.assign(this.landscape.dataset, {
      forestReady: 'true', drawCalls: `${calls}`, visibleTriangles: `${triangles}`,
      resolution: `${this.renderer.resolution}`,
      canvasMb: (this.canvas.width * this.canvas.height * 4 / 1024 ** 2).toFixed(2),
    });
    if (!this.landscape.dataset.firstFrameMs) this.landscape.dataset.firstFrameMs = performance.now().toFixed(1);
    if (flies?.animated && !document.hidden) {
      // Use the same queue as scrolling: one render per animation frame.
      this.requestFrame();
    }
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.onFailure(new Error('WebGL context lost'));
  };

  destroy() {
    this.destroyed = true;
    this.flies?.destroy();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.landscape.classList.remove('webgl-active');
    const buffers = new Set(this.layers.flatMap(l => l.batches.flatMap(b => b.mesh.geometry.buffers)));
    for (const layer of this.layers) {
      this.landscape.append(layer.source);
      for (const batch of layer.batches) batch.mesh.geometry.destroy();
      layer.shader.destroy();
    }
    buffers.forEach(buffer => buffer.destroy());
    this.mist?.geometry.destroy(true); this.mist?.shader?.destroy();
    this.root.destroy({ children: true });
    if (this.renderer.gl) this.renderer.destroy({ removeView: true });
    this.canvas.remove();
  }
}

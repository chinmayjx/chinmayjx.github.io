/** Serializable drawing instructions, shared by the worker and its canvas fallback. */
export type Bounds = { x: number; y: number; width: number; height: number };
export type Shape = {
  bounds: Bounds; opacity: number; d: string; fill: string; stroke: string;
  lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; fillRule: CanvasFillRule;
};
export type Group = { bounds: Bounds; opacity: number; children: Drawing[] };
export type Drawing = Shape | Group;
type Prepared = (Shape & { path: Path2D }) | (Omit<Group, 'children'> & { children: Prepared[] });
export type Scene = { drawings: Drawing[]; opacity: number; fade: [number, number][] };
export type PreparedScene = Omit<Scene, 'drawings'> & { drawings: Prepared[] };
export type TileRequest = {
  generation: number; layer: number; index: number;
  width: number; height: number; dpr: number; scale: number; shiftX: number; shiftY: number;
};
export type WorkerRequest = { type: 'scene'; scenes: Scene[] } | { type: 'tile'; tile: TileRequest };
export type TileResult = { tile: TileRequest; bitmap: ImageBitmap };
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function prepareScene(scene: Scene): PreparedScene {
  function prepare(drawings: Drawing[]): Prepared[] {
    return drawings.map(drawing => 'children' in drawing
      ? { ...drawing, children: prepare(drawing.children) }
      : { ...drawing, path: new Path2D(drawing.d) });
  }
  return { ...scene, drawings: prepare(scene.drawings) };
}

function surface(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}

function draw(ctx: Context, drawings: Prepared[], originX: number, originY: number, scale: number, width: number, height: number) {
  ctx.setTransform(scale, 0, 0, scale, -originX * scale, -originY * scale);
  for (const item of drawings) {
    const b = item.bounds;
    const x = Math.max(0, Math.floor((b.x - originX) * scale));
    const y = Math.max(0, Math.floor((b.y - originY) * scale));
    const right = Math.min(width, Math.ceil((b.x + b.width - originX) * scale));
    const bottom = Math.min(height, Math.ceil((b.y + b.height - originY) * scale));
    if (right <= x || bottom <= y) continue;
    if ('children' in item) {
      // SVG group opacity applies after its children overlap, notably on ferns.
      const group = surface(right - x, bottom - y);
      const groupContext = group.getContext('2d') as Context;
      draw(groupContext, item.children, originX + x / scale, originY + y / scale, scale, group.width, group.height);
      ctx.save();
      ctx.resetTransform();
      ctx.globalAlpha = item.opacity;
      ctx.drawImage(group, x, y);
      ctx.restore();
      group.width = group.height = 0;
    } else {
      ctx.globalAlpha = item.opacity;
      if (item.fill !== 'none') { ctx.fillStyle = item.fill; ctx.fill(item.path, item.fillRule); }
      if (item.stroke !== 'none') {
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = item.lineWidth;
        ctx.lineCap = item.lineCap; ctx.lineJoin = item.lineJoin;
        ctx.stroke(item.path);
      }
    }
  }
}

export function paintTile(ctx: Context, scene: PreparedScene, tile: TileRequest) {
  const { width, height, dpr, scale, index, shiftX, shiftY } = tile;
  const pixelWidth = Math.ceil(width * dpr), pixelHeight = Math.ceil(height * dpr);
  ctx.resetTransform();
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  draw(ctx, scene.drawings, (index * width - shiftX) / scale, -shiftY / scale, scale * dpr, pixelWidth, pixelHeight);
  ctx.resetTransform();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  if (scene.fade.length) {
    const gradient = ctx.createLinearGradient(0, 0, 0, pixelHeight);
    for (const [stop, alpha] of scene.fade) gradient.addColorStop(stop, `rgba(0,0,0,${alpha * scene.opacity})`);
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = `rgba(0,0,0,${scene.opacity})`;
  ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  ctx.globalCompositeOperation = 'source-over';
}

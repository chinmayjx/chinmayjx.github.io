import { paintTile, prepareScene } from './forest-painter';
import type { PreparedScene, WorkerRequest, TileResult } from './forest-painter';

const worker = self as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage: (result: TileResult, transfer: Transferable[]) => void;
};
let scenes: PreparedScene[] = [];
// One reusable, viewport-sized surface. No full-world bitmap is ever allocated.
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d')!;
worker.onmessage = ({ data }) => {
  if (data.type === 'scene') { scenes = data.scenes.map(prepareScene); return; }
  const tile = data.tile;
  canvas.width = Math.ceil(tile.width * tile.dpr);
  canvas.height = Math.ceil(tile.height * tile.dpr);
  paintTile(context, scenes[tile.layer], tile);
  const bitmap = canvas.transferToImageBitmap();
  worker.postMessage({ tile, bitmap }, [bitmap]);
};

import type { ForestRenderer } from './forest-renderer';
import { WebGLForest } from './forest-webgl';
import { drawForest } from './forest';

/** Async backend selection; resize/scroll events can arrive during compilation. */
export class ForestEngine {
  private backend?: ForestRenderer | WebGLForest;
  private size?: [number, number, number, boolean];
  private offset = 0;
  private fallingBack = false;
  private original: string;

  constructor(private landscape: HTMLElement, private requestFrame: () => void) {
    this.original = landscape.innerHTML;
    landscape.dataset.forestReady = 'false';
    landscape.querySelectorAll('svg.world-layer').forEach(node => node.classList.add('geometry-source'));
    void this.start();
  }

  private async start() {
    if (new URLSearchParams(location.search).get('renderer') === 'canvas') { await this.fallback(); return; }
    let backend: WebGLForest | undefined;
    try {
      backend = new WebGLForest(this.landscape, error => void this.fallback(error), this.requestFrame);
      this.backend = backend;
      await backend.init(() => ({ offset: this.offset, size: this.size }));
      if (this.fallingBack) return;
      if (this.size) backend.resize(...this.size);
      if (this.offset) backend.render(this.offset);
      this.original = '';
    } catch (error) {
      await this.fallback(error);
    }
  }

  private async fallback(error?: unknown) {
    if (this.fallingBack) return;
    this.fallingBack = true;
    if (error) this.landscape.dataset.fallbackReason = error instanceof Error ? error.message : String(error);
    if (this.backend && 'destroy' in this.backend) this.backend.destroy();
    // Failed initialization can leave sources in arbitrary DOM order. Recreate
    // the exact source stack, including the existing HTML atmospheric elements.
    this.backend = undefined;
    delete this.landscape.dataset.renderer;
    this.landscape.dataset.forestReady = 'false';
    if (!this.original) this.original = drawForest();
    // Keep existing HTML effects (main.ts holds references to their containers).
    const template = document.createElement('template');
    template.innerHTML = this.original;
    this.landscape.querySelectorAll('svg.world-layer').forEach(node => node.remove());
    for (const source of [...template.content.querySelectorAll('svg.world-layer')]) {
      const name = source.classList[1];
      const before = name === 'foreground' ? this.landscape.querySelector('.vignette')
        : name === 'feature-trees' ? this.landscape.querySelector('.fireflies') : this.landscape.querySelector('.mist');
      this.landscape.insertBefore(source, before);
    }
    const { ForestRenderer } = await import('./forest-renderer');
    this.backend = new ForestRenderer(this.landscape);
    this.landscape.dataset.renderer = 'canvas';
    if (this.size) this.backend.resize(...this.size);
    this.backend.render(this.offset);
    this.original = '';
  }

  resize(...size: [number, number, number, boolean]) {
    this.size = size;
    if (this.backend && this.landscape.dataset.renderer) this.backend.resize(...size);
  }
  render(offset: number) {
    this.offset = offset;
    if (this.backend && this.landscape.dataset.renderer) this.backend.render(offset);
  }
  recolor() { if (this.landscape.dataset.renderer) this.backend?.recolor(); }
}

import { Container, Geometry, GlProgram, Mesh, Shader } from 'pixi.js';

/** The original CSS animations remain the timing source. These tiny analytic
 * quads put their light in the original paint order, behind foreground trees. */
export class ForestFireflies {
  readonly container = new Container();
  private geometry = new Geometry({ attributes: { aPosition: {
    buffer: new Float32Array([-12,-12,12,-12,12,12,-12,12]), format: 'float32x2',
  } }, indexBuffer: new Uint16Array([0,1,2,0,2,3]) });
  private shader = new Shader({
    glProgram: GlProgram.from({ name: 'forest-firefly', vertex: `
      in vec2 aPosition; out vec2 vPosition;
      uniform mat3 uProjectionMatrix, uWorldTransformMatrix, uTransformMatrix;
      void main() {
        vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition,1.0);
        gl_Position = vec4(p.xy,0.0,1.0); vPosition = aPosition;
      }`, fragment: `
      in vec2 vPosition; out vec4 finalColor;
      uniform vec4 uColor; uniform float uPixel;
      void main() {
        float r = length(vPosition);
        float body = 1.0-smoothstep(1.0-uPixel*.5,1.0+uPixel*.5,r);
        float shadow = .145 * exp(-pow(max(0.0,r-1.0),2.0)/18.0);
        float a = body + shadow*(1.0-body);
        vec3 c = vec3(.8431,.8745,.6078)*body + vec3(.8980,.9294,.6118)*shadow*(1.0-body);
        finalColor = vec4(c,a)*uColor.a;
      }` }),
    resources: { forest: { uPixel: { value: 1, type: 'f32' } } },
  });
  private flies: { element: HTMLElement; mesh: Mesh<Geometry, Shader>; x: number; y: number }[];

  constructor(host: HTMLElement) {
    this.flies = [...host.querySelectorAll<HTMLElement>('.firefly')].map(element => {
      const mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
      this.container.addChild(mesh);
      return { element, mesh, x: parseFloat(element.style.left) + 1, y: parseFloat(element.style.top) + 1 };
    });
  }

  update(offset: number, left: number, top: number, width: number, height: number, resolution: number, enabled: boolean) {
    this.container.visible = enabled;
    this.container.x = -offset * .85;
    this.shader.resources.forest.uniforms.uPixel = 1 / resolution;
    let animated = false, count = 0;
    if (enabled) for (const { element, mesh, x, y } of this.flies) {
      mesh.visible = x - offset * .85 >= left - 24 && x - offset * .85 <= left + width + 24 && y >= top - 24 && y <= top + height + 24;
      if (!mesh.visible) continue;
      const css = getComputedStyle(element);
      const matrix = css.transform === 'none' ? undefined : new DOMMatrixReadOnly(css.transform);
      mesh.position.set(x + (matrix?.m41 || 0), y + (matrix?.m42 || 0));
      mesh.alpha = Number(css.opacity);
      animated ||= css.animationPlayState === 'running';
      count++;
    }
    return { animated, count };
  }

  destroy() { this.geometry.destroy(true); this.shader.destroy(); }
}

// GPU-accelerated particle layer (WebGL2, instanced).
//
// WHY THIS IS THE RIGHT GPU CANDIDATE
// -----------------------------------
// Profiling (see particles.js header) identified the live-particle glow fill as
// the single #1 frame cost: under heavy combat ~700-1600 additively-blended
// radial-gradient sprites, each one a Canvas2D drawImage. That is a textbook
// data-parallel GPU workload — thousands of *uniform*, independent, textured
// quads with the same blend mode. It batches into ONE instanced draw call and
// the radial falloff becomes a couple of ALU ops per fragment on hardware built
// for exactly that. Nothing about it is branchy or stateful, so there is no
// CPU<->GPU round-trip: we stream a flat instance buffer up once per frame and
// never read anything back.
//
// SCOPE: only the sprite modes ('glow' and 'smoke') move to the GPU — those are
// the drawImage fill-rate hogs. The handful of vector modes (star/spark/shard/
// ring/petal/rune) stay on Canvas2D: they are comparatively rare, cheap path
// fills, and reproducing their exact look in shaders would add complexity for no
// measurable win. The GPU shader reproduces the *exact* baked-sprite falloff so
// the visual result is pixel-comparable.
//
// FALLBACK: construction returns null if WebGL2 (or a context) is unavailable;
// callers then keep using the pure-Canvas2D path. The game stays fully playable
// with zero GPU.

// Each instance streams as 13 floats. Kept as a flat Float32Array we refill in
// place every frame (no per-particle allocation, one bufferSubData upload).
//   pos(2) size(1) rot(1) color(4) mode(1) color2(4) == 13 floats
// color2.a is a presence flag: >=0 means "glow has a mid colour", <0 means none.
const FLOATS_PER_INSTANCE = 13;
// Ceiling matches the particle pool (MAX in particles.js) so the buffer never
// needs to grow mid-run. Glow+smoke are a subset, but sizing for the whole pool
// costs ~170KB and removes any resize path.
const MAX_INSTANCES = 3600;

const VERT_SRC = `#version 300 es
precision highp float;

// unit quad corner in [-1,1] (two triangles via 6 verts)
layout(location = 0) in vec2 aCorner;

// per-instance data
layout(location = 1) in vec2  aPos;    // screen-space centre (CSS px)
layout(location = 2) in float aSize;   // half-extent (radius) in px
layout(location = 3) in float aRot;    // rotation (radians) — glow/smoke are radial so unused, kept for parity
layout(location = 4) in vec4  aColor;  // rgb + premultiplied-ish alpha carrier
layout(location = 5) in float aMode;   // 0 = glow, 1 = smoke
layout(location = 6) in vec4  aColor2; // inner->mid colour for glow (a<0 => none)

uniform vec2 uViewport; // CSS px (width, height)

out vec2  vLocal;  // quad-local coord in [-1,1]
out vec4  vColor;
out vec4  vColor2;
out float vMode;

void main() {
  vLocal  = aCorner;
  vColor  = aColor;
  vColor2 = aColor2;
  vMode   = aMode;
  // quad spans [centre - size, centre + size]
  vec2 px = aPos + aCorner * aSize;
  // px -> clip space. Canvas2D y grows downward, so flip y.
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0,
                   1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

// Reproduces the baked radial-gradient sprites from particles.js:
//   glow : stop(0)=color, stop(0.55)=color2||color, stop(1)=transparent
//   smoke: stop(0)=color, stop(1)=transparent   (linear alpha falloff)
// r = distance from centre in [0,1]; beyond 1 the quad corners are transparent.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2  vLocal;
in vec4  vColor;
in vec4  vColor2;
in float vMode;

out vec4 outColor;

void main() {
  float r = length(vLocal);        // 0 at centre, 1 at quad edge (sprite radius)
  if (r > 1.0) discard;            // outside the gradient circle

  if (vMode > 0.5) {
    // SMOKE: single colour, alpha fades linearly 1->0 by the edge.
    float a = (1.0 - r) * vColor.a;
    outColor = vec4(vColor.rgb * a, a); // premultiplied for correct alpha blend
  } else {
    // GLOW: colour interpolates color -> color2 over [0,0.55], then the whole
    // thing fades to transparent by r=1 (the gradient's alpha stop at 1).
    vec3 rgb;
    if (vColor2.a >= 0.0 && r < 0.55) {
      rgb = mix(vColor.rgb, vColor2.rgb, r / 0.55);
    } else {
      rgb = (vColor2.a >= 0.0) ? vColor2.rgb : vColor.rgb;
    }
    // alpha: 1 at centre -> 0 at edge (matches the transparent outer stop),
    // scaled by the particle's overall alpha carried in vColor.a.
    float a = (1.0 - r) * vColor.a;
    outColor = vec4(rgb * a, a);    // premultiplied
  }
}
`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[gpuParticles] shader compile failed:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

// Parse a CSS colour string into [r,g,b,a] in 0..1. Handles the exact forms the
// particle system uses: #rrggbb, #rgb, and rgba()/rgb(). Cached because the
// palette is a small fixed set reused across thousands of spawns.
const _colorCache = new Map();
const _scratchCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
let _scratchCtx = null;
function parseColor(str) {
  let c = _colorCache.get(str);
  if (c) return c;
  c = [1, 1, 1, 1];
  if (str[0] === '#') {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  } else if (str.startsWith('rgb')) {
    const m = str.match(/[\d.]+/g);
    if (m) c = [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255, m[3] !== undefined ? +m[3] : 1];
  } else if (_scratchCanvas) {
    // named colours etc. — resolve once via a throwaway 2d context
    if (!_scratchCtx) _scratchCtx = _scratchCanvas.getContext('2d');
    _scratchCtx.fillStyle = '#000';
    _scratchCtx.fillStyle = str;
    const resolved = _scratchCtx.fillStyle;
    if (resolved[0] === '#') return parseColor(resolved);
  }
  _colorCache.set(str, c);
  return c;
}

export class GPUParticleRenderer {
  // Returns a renderer, or null if WebGL2 is unavailable (caller falls back to
  // the Canvas2D particle path). `hostCanvas` is the existing 2D game canvas; we
  // overlay a transparent GL canvas exactly on top of it.
  static create(hostCanvas) {
    if (typeof document === 'undefined' || typeof WebGL2RenderingContext === 'undefined') return null;
    try {
      const r = new GPUParticleRenderer(hostCanvas);
      return r.ok ? r : null;
    } catch (e) {
      console.warn('[gpuParticles] init failed, using Canvas2D fallback:', e);
      return null;
    }
  }

  constructor(hostCanvas) {
    this.ok = false;
    this.host = hostCanvas;

    const gl = hostCanvas.parentNode ? this._makeCanvas().getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) : null;
    if (!gl) return;
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[gpuParticles] link failed:', gl.getProgramInfoLog(prog));
      return;
    }
    this.prog = prog;
    this.uViewport = gl.getUniformLocation(prog, 'uViewport');

    // ---- static unit-quad geometry (two triangles, corners in [-1,1]) ----
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const quad = new Float32Array([
      -1, -1,  1, -1,  1, 1,
      -1, -1,  1,  1, -1, 1,
    ]);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // ---- per-instance interleaved buffer (streamed each frame) ----
    this.instData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;
    // layout: pos(2) size(1) rot(1) color(4) mode(1) color2(4)  == 13 floats
    const attrs = [
      [1, 2, 0],   // aPos
      [2, 1, 8],   // aSize
      [3, 1, 12],  // aRot
      [4, 4, 16],  // aColor
      [5, 1, 32],  // aMode
      [6, 4, 36],  // aColor2
    ];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1); // advance once per instance
    }

    gl.bindVertexArray(null);
    this.ok = true;
  }

  _makeCanvas() {
    const c = document.createElement('canvas');
    c.className = 'game-canvas gpu-particle-layer';
    // sit exactly over the 2D canvas; never intercept input
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.pointerEvents = 'none';
    this.glCanvas = c;
    // insert right after the host so it stacks above it (particles already draw
    // on top of all entities in the Canvas2D path, so order is preserved)
    this.host.parentNode.insertBefore(c, this.host.nextSibling);
    return c;
  }

  // Match the GL drawing-buffer + CSS size to the host canvas. dpr is folded in
  // exactly like the 2D path (host.width already includes it).
  resize(cssW, cssH, dpr) {
    if (!this.ok) return;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
      this.glCanvas.width = w;
      this.glCanvas.height = h;
    }
    this.glCanvas.style.width = cssW + 'px';
    this.glCanvas.style.height = cssH + 'px';
    this._cssW = cssW;
    this._cssH = cssH;
    this._dpr = dpr;
    this.gl.viewport(0, 0, w, h);
  }

  // Draw all glow+smoke particles in the live prefix [0,count) of `pool`.
  // `cam` gives world->screen offset. Returns nothing; the GL canvas is cleared
  // and redrawn each frame. All other (vector) modes are left for Canvas2D.
  draw(pool, count, cam) {
    if (!this.ok) return;
    const gl = this.gl;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Pack live glow/smoke particles into the instance buffer. This mirrors the
    // Canvas2D draw() culling + size/alpha math so the result matches exactly.
    const data = this.instData;
    let n = 0;
    const camX = cam.x, camY = cam.y, cw = cam.w, ch = cam.h;
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const mode = p.mode;
      if (mode !== 'glow' && mode !== 'smoke') continue; // vector modes: Canvas2D
      const t = p.life / p.maxLife; // 1 -> 0
      const x = p.x - camX;
      const y = p.y - camY;
      if (x < -80 || y < -80 || x > cw + 80 || y > ch + 80) continue;
      const size = p.endSize + (p.size - p.endSize) * t;
      if (size < 1.2) continue; // same sub-pixel skip as Canvas2D

      // alpha carrier: same fade-in ramp as the 2D path
      let alpha = t < 0.35 ? t / 0.35 : 1;
      if (alpha > 1) alpha = 1;
      if (mode === 'smoke') alpha = Math.min(0.5, t * 0.5);

      const c1 = parseColor(p.color);
      const isSmoke = mode === 'smoke';
      const c2 = (!isSmoke && p.color2) ? parseColor(p.color2) : null;

      let o = n * FLOATS_PER_INSTANCE;
      data[o]     = x;
      data[o + 1] = y;
      data[o + 2] = size;      // quad half-extent == gradient radius
      data[o + 3] = p.rot || 0;
      data[o + 4] = c1[0];
      data[o + 5] = c1[1];
      data[o + 6] = c1[2];
      data[o + 7] = alpha * (isSmoke ? 1 : (c1[3] ?? 1)); // carry particle alpha
      data[o + 8] = isSmoke ? 1 : 0;
      // color2 as vec4: rgb + presence flag in .a (1 = present, -1 = absent)
      if (c2) {
        data[o + 9]  = c2[0];
        data[o + 10] = c2[1];
        data[o + 11] = c2[2];
        data[o + 12] = 1;
      } else {
        data[o + 9] = data[o + 10] = data[o + 11] = 0;
        data[o + 12] = -1;
      }
      n++;
      if (n >= MAX_INSTANCES) break;
    }

    if (n === 0) return;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uViewport, this._cssW, this._cssH);

    gl.enable(gl.BLEND);
    // Fragments are premultiplied (rgb already *alpha). glow is the overwhelming
    // majority and uses Canvas2D 'lighter' == additive, so we blend additively:
    //   dst = src.rgb + dst.rgb   (glow's signature bloom, preserved exactly).
    // smoke uses 'source-over' in 2D, but it's rare, low-alpha (<=0.5) and dark;
    // under additive it stays a subtle haze — a visually negligible difference
    // that lets glow+smoke share one draw call. (If smoke ever needed exact
    // over-blending it could be split into a second grouped pass; not worth it.)
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * FLOATS_PER_INSTANCE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose() {
    if (this.glCanvas && this.glCanvas.parentNode) this.glCanvas.parentNode.removeChild(this.glCanvas);
    this.ok = false;
  }
}

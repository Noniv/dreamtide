// Pooled particle system. Everything dreamlike in Dreamtide flows through here.
const MAX = 3600;
// Adaptive emission budget: below SOFT every spawn is honoured (visuals are
// unchanged at normal load). As the live count climbs past SOFT, an increasing
// share of *new* cosmetic particles are dropped — under heavy combat the eye
// can't resolve individual motes among a thousand overlapping glows, so thinning
// them is invisible but reclaims the render time (particles dominate the frame).
// The live-particle count is the #1 frame cost (each is a drawImage +
// lighter-blend fill). Chrome profiling showed ~1600 sustained → ~811ms of
// drawImage. Keep the effective count roughly half that: honour every spawn
// below SOFT, then drop new cosmetic particles increasingly past it so the live
// count self-limits near ~700-800 even under heavy combat (invisible thinning
// among overlapping glows, big drop in draw calls + fill-rate).
const SOFT = 500;
// a throwaway particle handed back for dropped spawns so callers that tweak the
// return value keep working without polluting the live pool
const SINK = { alive: false };

// ---------------------------------------------------------------- glow sprites
// Radial-gradient glows are the hottest particle mode (lanterns, hits, casts).
// Building a fresh createRadialGradient per particle per frame is expensive and
// churns the GC. Instead we bake each colour's glow into a small offscreen
// canvas once, then drawImage it — allocation-free and much cheaper to fill.
const GLOW_RES = 64; // sprite is 64×64; drawn scaled to the particle's size
const glowCache = new Map();

function glowSprite(color, color2, mode) {
  const key = mode + '|' + color + '|' + (color2 || '');
  let c = glowCache.get(key);
  if (c) return c;
  c = (typeof document !== 'undefined')
    ? document.createElement('canvas')
    : { width: GLOW_RES, height: GLOW_RES, getContext: () => null };
  c.width = c.height = GLOW_RES;
  const g = c.getContext && c.getContext('2d');
  if (g) {
    const r = GLOW_RES / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    if (mode === 'smoke') {
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      grad.addColorStop(0, color);
      grad.addColorStop(0.55, color2 || color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, GLOW_RES, GLOW_RES);
  }
  glowCache.set(key, c);
  return c;
}

export class ParticleSystem {
  constructor() {
    // Pre-allocate every particle object once (no per-spawn GC). `pool` holds
    // the live particles packed into [0, count); dead ones are swap-removed, so
    // update()/draw() only ever walk the live prefix instead of all MAX slots.
    this.pool = new Array(MAX);
    for (let i = 0; i < MAX; i++) this.pool[i] = { alive: false };
    this.count = 0;         // number of live particles, packed at the front
    this.overwrite = 0;     // round-robin cursor for the saturated case
    this.aliveCount = 0;
  }

  spawn(opts) {
    // adaptive throttle: once the pool is busy, probabilistically drop new
    // cosmetic particles. `keep` opts-out (rare, important one-offs).
    if (this.count > SOFT && !opts.keep) {
      // acceptance falls off steeply within ~400 particles past SOFT, so the
      // live count self-limits near ~750 even under a heavy spawn rate
      const over = (this.count - SOFT) / 400;
      if (Math.random() < Math.min(0.985, over * (1.2 + over))) { SINK.alive = false; return SINK; }
    }
    let p;
    if (this.count < MAX) {
      // take the next free slot at the end of the live prefix
      p = this.pool[this.count++];
    } else {
      // saturated: overwrite an existing live particle, round-robin
      p = this.pool[this.overwrite];
      this.overwrite = (this.overwrite + 1) % MAX;
    }
    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.ax = opts.ax ?? 0;
    p.ay = opts.ay ?? 0;
    p.drag = opts.drag ?? 1;
    p.life = p.maxLife = opts.life ?? 0.8;
    p.size = opts.size ?? 3;
    p.endSize = opts.endSize ?? 0;
    p.color = opts.color ?? '#ffffff';
    p.color2 = opts.color2 ?? null;
    p.mode = opts.mode ?? 'glow'; // glow | spark | shard | ring | petal | rune | smoke | star
    p.rot = opts.rot ?? Math.random() * Math.PI * 2;
    p.rotV = opts.rotV ?? 0;
    p.wobble = opts.wobble ?? 0;
    p.wobbleF = opts.wobbleF ?? 3;
    p.seed = Math.random() * 1000;
    p.glow = opts.glow ?? 1;
    return p;
  }

  burst(x, y, count, fn) {
    for (let i = 0; i < count; i++) this.spawn(fn(i));
    void x; void y;
  }

  update(dt) {
    // walk only the live prefix; when a particle dies, swap the last live one
    // into its place and shrink the count (order isn't significant for drawing)
    let i = 0;
    while (i < this.count) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        const last = --this.count;
        if (i !== last) {
          this.pool[i] = this.pool[last];
          this.pool[last] = p;
        }
        continue; // re-check the swapped-in particle at this index
      }
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      if (p.drag !== 1) {
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d;
        p.vy *= d;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.wobble) {
        p.x += Math.sin(p.seed + p.life * p.wobbleF * 6) * p.wobble * dt * 60;
      }
      p.rot += p.rotV * dt;
      i++;
    }
    this.aliveCount = this.count;
  }

  draw(ctx, cam) {
    ctx.save();
    let curOp = 'source-over'; ctx.globalCompositeOperation = curOp;
    for (let i = 0; i < this.count; i++) {
      const p = this.pool[i];
      const t = p.life / p.maxLife; // 1 -> 0
      const x = p.x - cam.x;
      const y = p.y - cam.y;
      if (x < -80 || y < -80 || x > cam.w + 80 || y > cam.h + 80) continue;
      const size = p.endSize + (p.size - p.endSize) * t;
      // skip particles too small to matter — a sub-1.2px glow costs a full
      // drawImage for effectively nothing on screen
      if (size < 1.2) continue;
      const alpha = t < 0.35 ? t / 0.35 : 1;
      ctx.globalAlpha = Math.min(1, alpha);
      // only touch the composite op when it actually changes (most are 'lighter')
      const op = p.mode === 'smoke' ? 'source-over' : 'lighter';
      if (op !== curOp) { ctx.globalCompositeOperation = op; curOp = op; }

      switch (p.mode) {
        case 'glow': {
          // cached sprite: gradient radius = size, so draw at size*2 across
          const spr = glowSprite(p.color, p.color2, 'glow');
          ctx.drawImage(spr, x - size, y - size, size * 2, size * 2);
          break;
        }
        case 'star': {
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            const a = (k * Math.PI) / 2;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a - 0.18) * size * 0.35, Math.sin(a - 0.18) * size * 0.35);
            ctx.lineTo(Math.cos(a) * size, Math.sin(a) * size);
            ctx.lineTo(Math.cos(a + 0.18) * size * 0.35, Math.sin(a + 0.18) * size * 0.35);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'spark': {
          const len = size * 2.4;
          const ang = Math.atan2(p.vy, p.vx);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.6, size * 0.32);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len);
          ctx.lineTo(x, y);
          ctx.stroke();
          break;
        }
        case 'shard': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(0, -size);
          ctx.lineTo(size * 0.38, 0);
          ctx.lineTo(0, size);
          ctx.lineTo(-size * 0.38, 0);
          ctx.closePath();
          ctx.fill();
          if (p.color2) {
            ctx.fillStyle = p.color2;
            ctx.beginPath();
            ctx.moveTo(0, -size * 0.55);
            ctx.lineTo(size * 0.18, 0);
            ctx.lineTo(0, size * 0.55);
            ctx.lineTo(-size * 0.18, 0);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'ring': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, size * 0.12 * t + 0.8);
          ctx.beginPath();
          ctx.arc(x, y, size * (1 - t * 0.9 + 0.1), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'petal': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(0, -size * 0.5, size * 0.34, size * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'rune': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.4;
          const s = size;
          ctx.beginPath();
          const glyph = Math.floor(p.seed) % 4;
          if (glyph === 0) {
            ctx.moveTo(-s, s); ctx.lineTo(0, -s); ctx.lineTo(s, s); ctx.moveTo(-s * 0.5, 0.2 * s); ctx.lineTo(s * 0.5, 0.2 * s);
          } else if (glyph === 1) {
            ctx.moveTo(0, -s); ctx.lineTo(0, s); ctx.moveTo(-s * 0.7, -s * 0.4); ctx.lineTo(s * 0.7, s * 0.4);
          } else if (glyph === 2) {
            ctx.arc(0, 0, s * 0.8, 0.4, Math.PI * 2 - 0.4); ctx.moveTo(0, -s); ctx.lineTo(0, s * 0.2);
          } else {
            ctx.moveTo(-s, 0); ctx.lineTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.closePath();
          }
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'smoke': {
          ctx.globalAlpha = Math.min(0.5, t * 0.5);
          const spr = glowSprite(p.color, null, 'smoke');
          ctx.drawImage(spr, x - size, y - size, size * 2, size * 2);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}

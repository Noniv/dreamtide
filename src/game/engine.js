import { ParticleSystem } from './particles.js';
import { SPELLS, BOONS, EVOLVE } from './spells.js';
import { audio } from './audio.js';
import { dustForRun } from './meta.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

// ---------------------------------------------------------------- enemy types
const ENEMY_TYPES = {
  wisp: {
    hp: 14, speed: 92, dmg: 8, radius: 13, xp: 1, color: '#7ff5ff',
    weight: (t) => 10,
  },
  bat: {
    hp: 22, speed: 118, dmg: 10, radius: 15, xp: 2, color: '#c48cff',
    weight: (t) => (t > 45 ? 9 : 0),
  },
  eye: {
    hp: 46, speed: 66, dmg: 14, radius: 18, xp: 3, color: '#ff9ad5',
    weight: (t) => (t > 110 ? 8 : 0),
  },
  shade: {
    hp: 80, speed: 84, dmg: 18, radius: 19, xp: 5, color: '#8a7bff',
    weight: (t) => (t > 190 ? 7 : 0),
  },
  golem: {
    hp: 220, speed: 40, dmg: 26, radius: 27, xp: 10, color: '#8fe8ff',
    weight: (t) => (t > 280 ? 5 : 0),
  },
  // ranged dreams — rarer than the melee tide
  siren: {
    hp: 30, speed: 74, dmg: 11, radius: 15, xp: 3, color: '#7dc9ff',
    weight: (t) => (t > 75 ? 3 : 0),
    ranged: { range: 330, cd: 2.6, projSpeed: 185, shots: 1 },
  },
  warlock: {
    hp: 95, speed: 58, dmg: 16, radius: 18, xp: 6, color: '#d98cff',
    weight: (t) => (t > 210 ? 2.5 : 0),
    ranged: { range: 380, cd: 3.4, projSpeed: 160, shots: 3 },
  },
};

// ------------------------------------------------------------- wave table
// Scripted windows instead of a smooth formula: each declares which enemies
// carry the difficulty, a minimum-alive floor, stepped HP/damage tiers and a
// scripted event. Past the last window, tiers keep climbing gently.
const WAVES = [
  { t: 0, floor: 8, rate: 1.5, types: { wisp: 10 }, hp: 1.0, dmg: 1.0 },
  { t: 45, floor: 14, rate: 1.15, types: { wisp: 10, bat: 4 }, hp: 1.15, dmg: 1.05, event: 'ring' },
  { t: 90, floor: 22, rate: 1.0, types: { wisp: 8, bat: 8 }, hp: 1.3, dmg: 1.15 },
  { t: 135, floor: 30, rate: 0.9, types: { bat: 8, wisp: 5, siren: 2 }, hp: 1.5, dmg: 1.25, event: 'pack' },
  { t: 180, floor: 40, rate: 0.8, types: { bat: 6, eye: 6, siren: 3 }, hp: 1.8, dmg: 1.35, event: 'wall' },
  { t: 240, floor: 52, rate: 0.7, types: { eye: 8, bat: 5, siren: 3 }, hp: 2.2, dmg: 1.45, event: 'ring' },
  { t: 300, floor: 64, rate: 0.6, types: { eye: 6, shade: 6, siren: 3 }, hp: 2.7, dmg: 1.55, event: 'pack' },
  { t: 360, floor: 78, rate: 0.55, types: { shade: 8, eye: 5, warlock: 2 }, hp: 3.3, dmg: 1.65, event: 'wall' },
  { t: 420, floor: 92, rate: 0.5, types: { shade: 7, golem: 4, warlock: 3 }, hp: 4.0, dmg: 1.75, event: 'ring' },
  { t: 480, floor: 106, rate: 0.45, types: { golem: 6, shade: 6, warlock: 3, siren: 2 }, hp: 4.8, dmg: 1.85, event: 'pack' },
  { t: 540, floor: 120, rate: 0.42, types: { golem: 7, shade: 5, warlock: 4 }, hp: 5.6, dmg: 1.95, event: 'wall' },
  { t: 600, floor: 135, rate: 0.4, types: { golem: 8, eye: 6, shade: 6, warlock: 4 }, hp: 6.5, dmg: 2.0, event: 'ring' },
];

export class Engine {
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks; // { onHud, onLevelUp, onGameOver }
    this.particles = new ParticleSystem();
    this.keys = {};
    this.running = false;
    this.paused = false;
    this._levelUpActive = false;
    this.reset();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  reset() {
    this.meta = (this.hooks.getMeta && this.hooks.getMeta()) || {};
    this.t = 0;
    this._cheated = false;
    this.banished = new Set();
    this.banishCharges = 2;
    this.breather = 0;
    this.bonusDust = 0;
    this.banner = null; // { str, color, life, maxLife }
    this.pickups = [];
    this.starTimer = 75;
    this._waveIdx = -1;
    this._waveEventAt = 0;
    this._waveEventDone = true;
    this._goldenAt = 0;
    this.kills = 0;
    this.shake = 0;
    this.hudTimer = 0;
    this.spawnTimer = 1.2;
    this.eliteTimer = 35;
    this.bossTimer = 95;
    this.bossCount = 0;
    this.flash = null; // {color, a}
    this.enemies = [];
    this.projectiles = [];
    this.zones = [];
    this.beams = [];
    this.bolts = [];
    this.gems = [];
    this.texts = [];
    this.orbitals = []; // petal waltz
    this.bossProjectiles = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    this.cam = { x: -vw / 2, y: -vh / 2, w: vw, h: vh };
    this.stars = [];
    for (let i = 0; i < 3; i++) {
      const layer = [];
      for (let j = 0; j < 70; j++) layer.push({ x: Math.random() * 2000, y: Math.random() * 2000, s: rand(0.6, 2.4 - i * 0.4), tw: Math.random() * 10 });
      this.stars.push(layer);
    }
    this.motes = [];
    for (let i = 0; i < 46; i++) this.motes.push({ x: rand(0, 1800), y: rand(0, 1800), r: rand(1.4, 4.2), sp: rand(4, 14), ph: Math.random() * TAU, hue: pick(['#b48cff', '#7ff5ff', '#ff9ad5', '#7dffb0']) });
    this.player = {
      x: 0, y: 0, vx: 0, vy: 0,
      hp: 100, maxHp: 100, speed: 190,
      level: 1, xp: 0, xpNext: 6,
      facing: 1, animT: 0, moving: false,
      iframes: 0, regenT: 0, dead: false,
      spells: [{ id: 'arcane', level: 1, cd: 0.3 }],
      boons: {},
      castPulse: 0,
      _genericPower: 0, _genericAoe: 0, _genericVital: 0,
    };
    // constellation (meta tree) bonuses
    const m = this.meta;
    if (m.hp) { this.player.maxHp += m.hp; this.player.hp = this.player.maxHp; }
    if (m.speed) this.player.speed *= 1 + m.speed / 100;
    if (m.magnet) this.player.metaMagnet = 1 + m.magnet / 100;
    if (m.twinSpark) {
      const ids = Object.keys(SPELLS).filter((id) => id !== 'arcane');
      this.player.spells.push({ id: pick(ids), level: 1, cd: 0.6 });
    }
    this.rebuildOrbitals();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam.w = window.innerWidth;
    this.cam.h = window.innerHeight;
  }

  bindInput() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      if (e.key === ' ') e.preventDefault();
      if (e.key === 'Escape' && !this.player.dead && !this._levelUpActive) {
        this.paused = !this.paused;
        this.pushHud(true);
      }
    });
    window.addEventListener('keyup', (e) => (this.keys[e.key.toLowerCase()] = false));
  }

  start() {
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      let dt = (now - this.last) / 1000;
      this.last = now;
      dt = Math.min(dt, 0.05);
      if (!this.paused) this.update(dt);
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  // -------------------------------------------------------------- boon math
  dmgMul() { return (1 + 0.12 * (this.player.boons.power || 0)) * (1 + 0.1 * (this.player._genericPower || 0)) * (1 + (this.meta.dmg || 0) / 100); }
  // "spell haste": all sources add into one pool with natural diminishing
  // returns — 100 haste halves cooldowns, the next 100 only cuts a third more
  cdMul() {
    const haste = (this.player.boons.haste || 0) * 10 + (this.meta.cast || 0);
    return 1 / (1 + haste / 100);
  }
  magnetR() { return 90 * (1 + 0.45 * (this.player.boons.magnet || 0)) * (this.player.metaMagnet || 1); }
  aoeMul() { return (1 + 0.1 * (this.player._genericAoe || 0)) * (1 + (this.meta.aoe || 0) / 100); }
  spellMaxLevel(id) { return SPELLS[id].maxLevel + (this.meta.maxLv || 0); }

  // level stats with school-cluster (constellation) modifiers folded in
  spellStats(id, lv) {
    const st = { ...SPELLS[id].stats(lv) };
    const m = this.meta.spellMods && this.meta.spellMods[id];
    if (!m) return st;
    if (st.damage != null) st.damage *= 1 + m.dmg / 100;
    if (st.dps != null) st.dps *= 1 + m.dmg / 100;
    if (st.cooldown) st.cooldown /= 1 + m.cd / 100;
    if (st.radius != null) st.radius *= 1 + m.aoe / 100;
    if (st.length != null) st.length *= 1 + m.aoe / 100;
    if (st.width != null) st.width *= 1 + m.aoe / 100;
    if (st.duration != null) st.duration *= 1 + m.dur / 100;
    if (st.slowDur != null) st.slowDur *= 1 + m.dur / 100;
    if (st.sleepDur != null) st.sleepDur *= 1 + m.dur / 100;
    if (m.count) {
      if (st.count != null) st.count += m.count;
      else if (st.chains != null) st.chains += m.count;
      else if (st.beams != null) st.beams += m.count;
    }
    return st;
  }

  applyBoon(id) {
    const p = this.player;
    p.boons[id] = (p.boons[id] || 0) + 1;
    if (id === 'vitality') { p.maxHp += 25; p.hp = Math.min(p.maxHp, p.hp + 25); }
    if (id === 'swift') p.speed *= 1.1;
  }

  addSpell(id) {
    const s = this.player.spells.find((s) => s.id === id);
    if (s) s.level++;
    else this.player.spells.push({ id, level: 1, cd: 0.4 });
    if (id === 'petals') this.rebuildOrbitals();
  }

  rebuildOrbitals() {
    const s = this.player.spells.find((s) => s.id === 'petals');
    this.orbitals = [];
    if (!s) return;
    const st = this.spellStats('petals', s.level);
    for (let i = 0; i < st.count; i++) this.orbitals.push({ a: (i / st.count) * TAU, hitCd: {}, dir: 1, radF: 1 });
    // Wild Garden: a second, wider ring waltzing the other way
    if (s.evolved) {
      for (let i = 0; i < st.count; i++) this.orbitals.push({ a: (i / st.count) * TAU + TAU / (st.count * 2), hitCd: {}, dir: -1, radF: 1.45 });
    }
  }

  // -------------------------------------------------------------- level ups
  gainXp(n) {
    const p = this.player;
    p.xp += n * (1 + (this.meta.xp || 0) / 100);
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = Math.floor(6 + Math.pow(p.level, 1.55) * 3.4);
      this.offerChoices();
    }
  }

  buildChoices() {
    const p = this.player;
    const isStatLevel = p.level % 5 === 0;
    const banned = (kind, id) => this.banished.has(`${kind}:${id}`);
    const pool = [];
    const genericPool = () => {
      pool.push({ kind: 'generic', id: 'power', level: (p._genericPower || 0) + 1 });
      pool.push({ kind: 'generic', id: 'aoe', level: (p._genericAoe || 0) + 1 });
      pool.push({ kind: 'generic', id: 'vital', level: (p._genericVital || 0) + 1 });
    };

    // evolutions: any maxed, un-evolved spell may transcend
    const evolvePool = [];
    for (const id of Object.keys(SPELLS)) {
      const owned = p.spells.find((s) => s.id === id);
      if (owned && !owned.evolved && owned.level >= this.spellMaxLevel(id) && !banned('spell', id)) {
        evolvePool.push({ kind: 'evolve', id });
      }
    }

    if (isStatLevel) {
      for (const id of Object.keys(BOONS)) {
        if ((p.boons[id] || 0) < BOONS[id].max && !banned('boon', id)) pool.push({ kind: 'boon', id, level: (p.boons[id] || 0) + 1 });
      }
      if (pool.length === 0) genericPool();
    } else {
      for (const id of Object.keys(SPELLS)) {
        if (banned('spell', id)) continue;
        const owned = p.spells.find((s) => s.id === id);
        if (!owned && p.spells.length < 6) pool.push({ kind: 'spell', id, isNew: true });
        else if (owned && owned.level < this.spellMaxLevel(id)) pool.push({ kind: 'spell', id, isNew: false, level: owned.level + 1 });
      }
      if (pool.length === 0 && evolvePool.length === 0) genericPool();
    }

    const choices = [];
    const nChoices = this.meta.fourfold ? 4 : 3;
    // an available evolution always claims one slot — it's the run's big moment
    if (evolvePool.length && !isStatLevel) choices.push(evolvePool[(Math.random() * evolvePool.length) | 0]);
    while (choices.length < nChoices && pool.length) {
      const i = (Math.random() * pool.length) | 0;
      choices.push(pool.splice(i, 1)[0]);
    }
    if (choices.length === 0) { genericPool(); choices.push(pool[0]); }
    return choices;
  }

  offerChoices() {
    this._levelUpActive = true;
    this.paused = true;
    audio.levelUp();
    this.hooks.onLevelUp(this.buildChoices(), this.player.level, this.banishCharges);
  }

  banish(choice) {
    if (this.banishCharges <= 0) return;
    this.banishCharges--;
    const kind = choice.kind === 'evolve' ? 'spell' : choice.kind;
    this.banished.add(`${kind}:${choice.id}`);
    this.hooks.onLevelUp(this.buildChoices(), this.player.level, this.banishCharges);
  }

  chooseUpgrade(choice) {
    if (choice.kind === 'spell') this.addSpell(choice.id);
    else if (choice.kind === 'boon') this.applyBoon(choice.id);
    else if (choice.kind === 'generic') this.applyGeneric(choice.id);
    else if (choice.kind === 'evolve') {
      const s = this.player.spells.find((x) => x.id === choice.id);
      if (s) {
        s.evolved = true;
        if (choice.id === 'petals') this.rebuildOrbitals();
        this.setBanner(`${SPELLS[choice.id].name.toUpperCase()} → ${EVOLVE[choice.id].name.toUpperCase()}`, SPELLS[choice.id].color);
        this.flash = { color: '255,210,122', a: 0.3 };
      }
    }
    audio.choose();
    this._levelUpActive = false;
    this.paused = false;
    // celebratory ring
    const p = this.player;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU;
      this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(120, 300), vy: Math.sin(a) * rand(120, 300), life: rand(0.5, 1.1), size: rand(2, 5), color: '#ffd27a', color2: '#b48cff', mode: 'star', rotV: rand(-4, 4), drag: 0.92 });
    }
    this.pushHud(true);
  }

  applyGeneric(id) {
    const p = this.player;
    if (id === 'power') { p._genericPower = (p._genericPower || 0) + 1; }
    if (id === 'aoe') { p._genericAoe = (p._genericAoe || 0) + 1; }
    if (id === 'vital') { p._genericVital = (p._genericVital || 0) + 1; p.maxHp += 15; p.hp = Math.min(p.maxHp, p.hp + 15); }
  }

  // -------------------------------------------------------------- spawning
  currentWave() {
    let idx = 0;
    for (let i = 0; i < WAVES.length; i++) { if (this.t >= WAVES[i].t) idx = i; else break; }
    const w = WAVES[idx];
    if (idx === WAVES.length - 1) {
      const extra = Math.floor((this.t - w.t) / 60);
      if (extra > 0) {
        return {
          ...w, idx: idx + extra,
          hp: w.hp + extra * 1.2,
          floor: Math.min(190, w.floor + extra * 12),
          event: ['ring', 'wall', 'pack'][extra % 3],
        };
      }
    }
    return { ...w, idx };
  }

  difficulty() {
    const w = this.currentWave();
    return { hpMul: w.hp, spdMul: 1 + Math.min(0.5, this.t * 0.0008), rate: w.rate, dmgMul: w.dmg };
  }

  setBanner(str, color = '#cdd8ff') {
    this.banner = { str, color, life: 3, maxLife: 3 };
  }

  spawnEnemy(typeId, elite = false, boss = false) {
    const def = ENEMY_TYPES[typeId] || ENEMY_TYPES.wisp;
    const d = this.difficulty();
    const ang = Math.random() * TAU;
    const R = Math.max(this.cam.w, this.cam.h) * 0.62 + 60;
    const mul = boss ? 1 : elite ? 2.5 : 1;
    const e = {
      type: typeId, boss,
      x: this.player.x + Math.cos(ang) * R,
      y: this.player.y + Math.sin(ang) * R,
      hp: def.hp * d.hpMul * mul * (boss ? 35 + this.bossCount * 25 : 1),
      maxHp: 0,
      speed: def.speed * d.spdMul * (elite ? 1.12 : 1) * (boss ? 0.75 : 1),
      dmg: def.dmg * d.dmgMul * (elite ? 1.5 : 1) * (boss ? 1.6 : 1),
      radius: def.radius * (elite ? 1.55 : 1) * (boss ? 3.4 : 1),
      xp: Math.max(1, Math.round(def.xp * (1 + (d.hpMul - 1) * 0.3))) * (elite ? 6 : 1),
      color: def.color, elite,
      slow: 0, slowT: 0, hitFlash: 0, animT: Math.random() * 10, seed: Math.random() * 1000,
      knbx: 0, knby: 0,
    };
    e.maxHp = e.hp;
    this.enemies.push(e);
    if (boss) {
      audio.bossRoar();
      this.flash = { color: '154,92,255', a: 0.35 };
      this.texts.push({ x: e.x, y: e.y - 60, str: 'THE DEVOURER STIRS', color: '#c48cff', life: 2.4, vy: -12, size: 22 });
    }
    return e;
  }

  updateSpawning(dt) {
    const w = this.currentWave();
    // entering a new window: schedule its event and maybe a golden wisp
    if (this._waveIdx !== w.idx) {
      this._waveIdx = w.idx;
      this._waveEventAt = this.t + rand(12, 30);
      this._waveEventDone = !w.event;
      this._goldenAt = Math.random() < 0.35 ? this.t + rand(15, 40) : 0;
    }
    const pickType = () => {
      const entries = Object.entries(w.types);
      const total = entries.reduce((s, [, x]) => s + x, 0);
      let r = Math.random() * total;
      for (const [id, x] of entries) { r -= x; if (r <= 0) return id; }
      return entries[0][0];
    };

    // breather after a boss falls: the tide recedes
    if (this.breather > 0) {
      this.breather -= dt;
    } else {
      this.spawnTimer -= dt;
      const alive = this.enemies.length;
      if (alive < w.floor && this.spawnTimer <= 0) {
        // refill quickly up to the wave's floor
        this.spawnTimer = 0.2;
        const n = Math.min(6, w.floor - alive);
        for (let i = 0; i < n; i++) this.spawnEnemy(pickType());
      } else if (this.spawnTimer <= 0 && alive < 230) {
        this.spawnTimer = w.rate * rand(0.7, 1.3);
        const burst = 1 + ((Math.random() * 3) | 0);
        for (let i = 0; i < burst; i++) this.spawnEnemy(pickType());
      }
      if (!this._waveEventDone && this.t >= this._waveEventAt) {
        this._waveEventDone = true;
        this.spawnEvent(w.event, pickType);
      }
    }

    if (this._goldenAt && this.t >= this._goldenAt) {
      this._goldenAt = 0;
      this.spawnGolden();
    }

    this.eliteTimer -= dt;
    if (this.eliteTimer <= 0) {
      this.eliteTimer = Math.max(32, 50 - this.t / 40);
      this.spawnEnemy(pickType(), true);
    }
    this.bossTimer -= dt;
    if (this.bossTimer <= 0) {
      this.bossTimer = 115;
      this.bossCount++;
      this.spawnEnemy('eye', false, true);
    }
  }

  spawnEvent(kind, pickType) {
    const p = this.player;
    if (kind === 'ring') {
      this.setBanner('THE TIDE ENCIRCLES YOU', '#ff9ad5');
      const n = 22 + Math.min(18, (this.t / 30) | 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const e = this.spawnEnemy(pickType());
        e.x = p.x + Math.cos(a) * 560;
        e.y = p.y + Math.sin(a) * 560;
      }
    } else if (kind === 'wall') {
      this.setBanner('A WALL OF DREAMS ADVANCES', '#8a7bff');
      const a = rand(0, TAU);
      const nx = Math.cos(a), ny = Math.sin(a);
      for (let i = 0; i < 26; i++) {
        const off = (i - 13) * 55;
        const e = this.spawnEnemy(pickType());
        e.x = p.x + nx * 700 - ny * off;
        e.y = p.y + ny * 700 + nx * off;
      }
    } else if (kind === 'pack') {
      this.setBanner('AN ELITE PACK STIRS', '#ffd27a');
      const a = rand(0, TAU);
      const cx = p.x + Math.cos(a) * 620, cy = p.y + Math.sin(a) * 620;
      const elite = this.spawnEnemy(pickType(), true);
      elite.x = cx; elite.y = cy;
      for (let i = 0; i < 8; i++) {
        const e = this.spawnEnemy(pickType());
        e.x = cx + rand(-90, 90);
        e.y = cy + rand(-90, 90);
      }
    }
  }

  spawnGolden() {
    const d = this.difficulty();
    const a = rand(0, TAU);
    const e = {
      type: 'wisp', golden: true, boss: false, elite: false,
      x: this.player.x + Math.cos(a) * 480, y: this.player.y + Math.sin(a) * 480,
      hp: 70 * d.hpMul, maxHp: 70 * d.hpMul,
      speed: 150, dmg: 0, radius: 14, xp: 4, color: '#ffd27a',
      slow: 0, slowT: 0, hitFlash: 0, animT: Math.random() * 10, seed: Math.random() * 1000,
      knbx: 0, knby: 0, goldT: 12,
    };
    this.enemies.push(e);
    this.setBanner('A GOLDEN WISP FLITS PAST', '#ffd27a');
  }

  // -------------------------------------------------------------- spells
  visibleEnemies() {
    const { x: cx, y: cy, w, h } = this.cam;
    const margin = 80;
    const left = cx - margin, right = cx + w + margin;
    const top = cy - margin, bottom = cy + h + margin;
    return this.enemies.filter((e) => !e.dead && e.x >= left && e.x <= right && e.y >= top && e.y <= bottom);
  }

  nearestEnemy(x, y, maxR = Infinity, exclude = null, preferBoss = false) {
    let best = null, bd = maxR * maxR;
    let boss = null, bossD = Infinity;
    const halfScreen = Math.max(this.cam.w, this.cam.h) * 0.5;
    const bossRange = halfScreen * halfScreen;
    const { x: cx, y: cy, w, h } = this.cam;
    const margin = 80;
    const left = cx - margin, right = cx + w + margin;
    const top = cy - margin, bottom = cy + h + margin;
    for (const e of this.enemies) {
      if (e === exclude || e.dead) continue;
      if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
      const d = dist2(x, y, e.x, e.y);
      if (preferBoss && e.boss && d < bossRange) {
        if (d < bossD) { bossD = d; boss = e; }
      }
      if (d < bd) { bd = d; best = e; }
    }
    if (preferBoss && boss) return boss;
    return best;
  }

  // targeting: nearest enemy, but while a boss is visible a share of casts
  // divert to it — steady boss pressure without ignoring the swarm
  pickTarget(x, y, maxR = Infinity) {
    const nearest = this.nearestEnemy(x, y, maxR);
    if (nearest && !nearest.boss) {
      const boss = this.enemies.find((e) => e.boss && !e.dead && dist2(x, y, e.x, e.y) < maxR * maxR);
      if (boss && Math.random() < 0.35) return boss;
    }
    return nearest;
  }

  // targeting for placed AoE: the point where a blast of the given radius
  // catches the most; bosses count triple, elites double
  densestPoint(radius) {
    const vis = this.visibleEnemies();
    if (!vis.length) return null;
    // sample if the horde is huge — scoring is O(n²)
    let cand = vis;
    if (cand.length > 70) {
      cand = [];
      for (let i = 0; i < 70; i++) cand.push(vis[(Math.random() * vis.length) | 0]);
    }
    const r2 = radius * radius;
    let best = null, bestScore = -1;
    for (const e of cand) {
      let score = 0;
      for (const o of vis) {
        if (dist2(e.x, e.y, o.x, o.y) < r2) score += o.boss ? 3 : o.elite ? 2 : 1;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  castSpells(dt) {
    const p = this.player;
    const visible = this.visibleEnemies().length > 0;
    for (const s of p.spells) {
      const st = this.spellStats(s.id, s.level);
      st.evolved = !!s.evolved;
      if (s.id === 'petals') continue; // continuous
      s.cd -= dt;
      if (s.cd > 0) continue;
      if (!visible) { s.cd = 0.05; continue; }
      s.cd = Math.max(0.12, st.cooldown * this.cdMul());
      this.cast(s.id, st);
      if (this.meta.echo && Math.random() < this.meta.echo / 100) this.cast(s.id, st);
    }
    this.updateOrbitals(dt);
  }

  cast(id, st) {
    const p = this.player;
    p.castPulse = 1;
    switch (id) {
      case 'arcane': {
        const target = this.pickTarget(p.x, p.y, 640);
        for (let i = 0; i < st.count + (this.meta.extraCount || 0); i++) {
          const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
          const a = baseA + rand(-0.7, 0.7);
          this.projectiles.push({
            kind: 'arcane', x: p.x, y: p.y - 26,
            vx: Math.cos(a) * st.speed * 0.5, vy: Math.sin(a) * st.speed * 0.5,
            speed: st.speed, dmg: st.damage * this.dmgMul(), life: 2.6, r: 7,
            turn: 7.5, target, splinter: st.evolved,
          });
        }
        audio.arcaneCast(rand(-0.4, 0.4));
        break;
      }
      case 'ember': {
        const blastR = st.radius * this.aoeMul();
        const cluster = this.densestPoint(blastR);
        for (let i = 0; i < st.count + (this.meta.extraCount || 0); i++) {
          // first ember on the thickest knot, the rest carpet around it
          const spread = i === 0 ? 20 : blastR * 0.9;
          const tx = cluster ? cluster.x + rand(-spread, spread) : p.x + rand(-260, 260);
          const ty = cluster ? cluster.y + rand(-spread, spread) : p.y + rand(-260, 260);
          const flight = rand(0.55, 0.8);
          this.projectiles.push({
            kind: 'ember', x: p.x, y: p.y - 30, sx: p.x, sy: p.y - 30, tx, ty,
            t: 0, dur: flight, arc: rand(70, 150),
            dmg: st.damage * this.dmgMul(), radius: st.radius * this.aoeMul(), r: 9,
            burn: st.evolved ? { c1: '#ff8c5a', c2: '#ffd27a', dps: st.damage * this.dmgMul() * 0.4 } : null,
          });
        }
        audio.fireCast();
        break;
      }
      case 'frost': {
        audio.frostCast();
        const R = st.radius * this.aoeMul();
        this.zones.push({ kind: 'frostwave', x: p.x, y: p.y, r: 10, maxR: R, life: 0.45, maxLife: 0.45, dmg: st.damage * this.dmgMul(), slow: st.evolved ? 1 : st.slow, slowDur: st.slowDur + (st.evolved ? 0.8 : 0), hit: new Set() });
        for (let i = 0; i < 70; i++) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: p.x + Math.cos(a) * 14, y: p.y + Math.sin(a) * 14, vx: Math.cos(a) * rand(180, R * 2.4), vy: Math.sin(a) * rand(180, R * 2.4), life: rand(0.35, 0.7), size: rand(3, 8), endSize: 1, color: '#e8fbff', color2: '#8fe8ff', mode: Math.random() < 0.5 ? 'shard' : 'glow', rotV: rand(-8, 8), drag: 0.88 });
        }
        break;
      }
      case 'storm': {
        const first = this.pickTarget(p.x, p.y, st.range);
        if (!first) return;
        audio.stormCast();
        let from = { x: p.x, y: p.y - 34 };
        let cur = first;
        const hitSet = new Set();
        const chains = st.chains + (st.evolved ? 3 : 0);
        const falloff = st.evolved ? 0.92 : 0.85;
        for (let c = 0; c <= chains && cur; c++) {
          this.spawnBolt(from.x, from.y, cur.x, cur.y);
          this.damageEnemy(cur, st.damage * this.dmgMul() * Math.pow(falloff, c), '#bfeaff');
          hitSet.add(cur);
          for (let i = 0; i < 10; i++) this.particles.spawn({ x: cur.x, y: cur.y, vx: rand(-160, 160), vy: rand(-160, 160), life: rand(0.15, 0.4), size: rand(2, 4), color: '#dff4ff', mode: 'spark', drag: 0.85 });
          from = cur;
          cur = null;
          let bd = 240 * 240;
          const { x: cx, y: cy, w, h } = this.cam;
          const margin = 80;
          const left = cx - margin, right = cx + w + margin;
          const top = cy - margin, bottom = cy + h + margin;
          for (const e of this.enemies) {
            if (hitSet.has(e) || e.dead) continue;
            if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
            const d = dist2(from.x, from.y, e.x, e.y);
            if (d < bd) { bd = d; cur = e; }
          }
        }
        this.shake = Math.min(10, this.shake + 3);
        break;
      }
      case 'void': {
        // open at the densest cluster of visible enemies (pull reaches beyond r)
        const riftR = st.radius * this.aoeMul();
        const pt = this.densestPoint(riftR * 1.4);
        const bx = pt ? pt.x : p.x + rand(-220, 220);
        const by = pt ? pt.y : p.y + rand(-220, 220);
        audio.voidCast();
        this.zones.push({ kind: 'rift', x: bx, y: by, r: riftR, life: st.duration, maxLife: st.duration, dps: st.dps * this.dmgMul(), pull: st.pull, tick: 0, spin: rand(0, TAU), evolved: st.evolved });
        break;
      }
      case 'moon': {
        audio.beamHum();
        const target = this.pickTarget(p.x, p.y, 800);
        const a = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        const beamLife = st.evolved ? 0.75 : 0.5;
        for (let b = 0; b < st.beams; b++) {
          const ang = a + b * Math.PI;
          this.beams.push({ x: p.x, y: p.y - 20, a: ang, len: st.length, w: st.width, life: beamLife, maxLife: beamLife, dmg: st.damage * this.dmgMul(), hit: new Set(), sweep: st.evolved ? (b % 2 ? 1 : -1) * 2.0 : 0 });
        }
        this.shake = Math.min(9, this.shake + 2.5);
        break;
      }
      case 'starfall': {
        audio.starfallCast();
        const count = st.count + (this.meta.extraCount || 0);
        const blastR = st.radius * this.aoeMul();
        const cluster = this.densestPoint(blastR);
        for (let i = 0; i < count; i++) {
          const spread = i === 0 ? 16 : blastR * 0.9;
          const tx = cluster ? cluster.x + rand(-spread, spread) : p.x + rand(-300, 300);
          const ty = cluster ? cluster.y + rand(-spread, spread) : p.y + rand(-300, 300);
          this.projectiles.push({
            kind: 'comet', tx, ty,
            x: tx + rand(-140, -60), y: ty - 560,
            t: 0, dur: rand(0.5, 0.7),
            dmg: st.damage * this.dmgMul(), radius: st.radius * this.aoeMul(),
            burn: st.evolved ? { c1: '#ffb3f2', c2: '#8a7bff', dps: st.damage * this.dmgMul() * 0.35 } : null,
          });
        }
        break;
      }
      case 'umbra': {
        audio.fangCast();
        const count = st.count + (this.meta.extraCount || 0) + (st.evolved ? 2 : 0);
        const target = this.pickTarget(p.x, p.y, 640);
        const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        for (let i = 0; i < count; i++) {
          const a = baseA + (i - (count - 1) / 2) * 0.22;
          this.projectiles.push({
            kind: 'fang', x: p.x, y: p.y - 18,
            vx: Math.cos(a) * st.speed, vy: Math.sin(a) * st.speed,
            dmg: st.damage * this.dmgMul(), life: 1.5, r: 12, hit: new Set(), chill: st.evolved,
          });
        }
        break;
      }
      case 'glaive': {
        audio.glaiveCast();
        const count = st.count + (this.meta.extraCount || 0);
        const target = this.pickTarget(p.x, p.y, 700);
        const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        for (let i = 0; i < count; i++) {
          const a = baseA + i * (TAU / Math.max(2, count * 2));
          this.projectiles.push({
            kind: 'glaive', x: p.x, y: p.y - 20, a,
            travelled: 0, range: st.range, speed: st.speed, returning: false,
            dmg: st.damage * this.dmgMul(), life: 6, r: 14, spin: 0, hitCd: {}, evolved: st.evolved,
          });
        }
        break;
      }
      case 'nebula': {
        audio.nebulaCast();
        const cloudR = st.radius * this.aoeMul() * (st.evolved ? 1.25 : 1);
        const pt = this.densestPoint(cloudR);
        const bx = pt ? pt.x : p.x + rand(-220, 220);
        const by = pt ? pt.y : p.y + rand(-220, 220);
        const driftA = rand(0, TAU);
        this.zones.push({
          kind: 'nebula', x: bx, y: by, r: cloudR,
          life: st.duration, maxLife: st.duration, dps: st.dps * this.dmgMul(),
          tick: 0, dvx: Math.cos(driftA) * 16, dvy: Math.sin(driftA) * 16,
          seed: rand(0, TAU), evolved: st.evolved,
        });
        break;
      }
      case 'sigil': {
        // inscribe under the densest visible cluster; detonates after arming
        const sigR = st.radius * this.aoeMul();
        const pt = this.densestPoint(sigR);
        const bx = pt ? pt.x : p.x + rand(-200, 200);
        const by = pt ? pt.y : p.y + rand(-200, 200);
        this.zones.push({
          kind: 'sigil', x: bx, y: by, r: sigR,
          life: 1.1, maxLife: 1.1, dmg: st.damage * this.dmgMul(), sleepDur: st.sleepDur,
          echo: st.evolved,
        });
        break;
      }
      case 'lantern': {
        audio.lanternCast();
        const count = st.count + (this.meta.extraCount || 0);
        for (let i = 0; i < count; i++) {
          const a = rand(0, TAU);
          this.projectiles.push({
            kind: 'lantern', x: p.x + Math.cos(a) * 26, y: p.y - 20 + Math.sin(a) * 26,
            vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 40,
            speed: st.speed, dmg: st.damage * this.dmgMul() * (st.evolved ? 1.25 : 1),
            radius: st.radius * this.aoeMul() * (st.evolved ? 1.5 : 1),
            life: 5, r: 8, target: null, ph: rand(0, TAU),
          });
        }
        break;
      }
      case 'nova': {
        audio.novaCast();
        const R = st.radius * this.aoeMul();
        this.zones.push({ kind: 'novawave', x: p.x, y: p.y, r: 10, maxR: R, life: 0.5, maxLife: 0.5, dmg: st.damage * this.dmgMul(), knock: st.knock, hit: new Set() });
        // Endless Dusk: a second wave follows the first
        if (st.evolved) this.zones.push({ kind: 'novawave', x: p.x, y: p.y, r: 10, maxR: R * 1.1, life: 0.5, maxLife: 0.5, delay: 0.35, dmg: st.damage * this.dmgMul() * 0.7, knock: st.knock * 0.7, hit: new Set() });
        this.shake = Math.min(10, this.shake + 3);
        for (let i = 0; i < 50; i++) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(160, R * 2.2), vy: Math.sin(a) * rand(160, R * 2.2), life: rand(0.3, 0.7), size: rand(3, 7), endSize: 1, color: '#ff9ad5', color2: '#5a2a6e', mode: 'glow', drag: 0.87 });
        }
        break;
      }
    }
  }

  spawnBolt(x1, y1, x2, y2) {
    const pts = [{ x: x1, y: y1 }];
    const segs = 7 + ((Math.random() * 4) | 0);
    const dx = x2 - x1, dy = y2 - y1;
    const nx = -dy, ny = dx;
    const L = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < segs; i++) {
      const f = i / segs;
      const off = rand(-0.16, 0.16) * (1 - Math.abs(f - 0.5) * 1.4);
      pts.push({ x: x1 + dx * f + (nx / L) * off * L, y: y1 + dy * f + (ny / L) * off * L });
    }
    pts.push({ x: x2, y: y2 });
    this.bolts.push({ pts, life: 0.22, maxLife: 0.22 });
  }

  updateOrbitals(dt) {
    const s = this.player.spells.find((s) => s.id === 'petals');
    if (!s) return;
    const st = this.spellStats('petals', s.level);
    const p = this.player;
    for (const o of this.orbitals) {
      o.a += st.speed * dt * (o.dir || 1);
      const R = st.radius * (o.radF || 1);
      o.x = p.x + Math.cos(o.a) * R;
      o.y = p.y + Math.sin(o.a) * R * 0.92;
      // trail
      if (Math.random() < 0.6) this.particles.spawn({ x: o.x, y: o.y, vx: rand(-15, 15), vy: rand(-25, 5), life: rand(0.3, 0.7), size: rand(2.5, 5), color: Math.random() < 0.5 ? '#7dffb0' : '#ffd1ec', mode: 'petal', rotV: rand(-6, 6), drag: 0.95 });
      for (const e of this.enemies) {
        if (e.dead) continue;
        const key = e.seed;
        if (o.hitCd[key] > this.t) continue;
        if (dist2(o.x, o.y, e.x, e.y) < (e.radius + 14) ** 2) {
          o.hitCd[key] = this.t + 0.5;
          this.damageEnemy(e, st.damage * this.dmgMul(), '#7dffb0');
          audio.petalTick();
          const a = Math.atan2(e.y - p.y, e.x - p.x);
          e.knbx += Math.cos(a) * 120;
          e.knby += Math.sin(a) * 120;
        }
      }
    }
  }

  // -------------------------------------------------------------- damage
  damageEnemy(e, dmg, color = '#fff') {
    if (e.dead) return;
    let crit = false;
    if (this.meta.crit && Math.random() < this.meta.crit / 100) {
      crit = true;
      dmg *= 1.5 + (this.meta.critDmg || 0) / 100;
    }
    e.hp -= dmg;
    e.hitFlash = 0.12;
    audio.hit();
    this.texts.push({ x: e.x + rand(-8, 8), y: e.y - e.radius - 6, str: String(Math.round(dmg)) + (crit ? '!' : ''), color: crit ? '#ffd27a' : color, life: crit ? 0.85 : 0.65, vy: -55, size: (e.boss ? 18 : 13) + (crit ? 4 : 0) });
    if (e.hp <= 0) this.killEnemy(e);
  }

  killEnemy(e) {
    e.dead = true;
    this.kills++;
    // death burst in the enemy's own hue
    const n = e.boss ? 160 : e.elite ? 46 : 18;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, e.boss ? 420 : 240);
      this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, e.boss ? 1.6 : 0.9), size: rand(2, e.boss ? 8 : 5), color: e.color, color2: '#ffffff', mode: Math.random() < 0.7 ? 'glow' : 'star', rotV: rand(-5, 5), drag: 0.9 });
    }
    this.particles.spawn({ x: e.x, y: e.y, life: 0.5, size: e.radius * (e.boss ? 4 : 2.6), color: e.color, mode: 'ring' });
    if (e.boss) {
      audio.fireBoom();
      this.shake = 16;
      this.flash = { color: '255,210,122', a: 0.4 };
      for (let i = 0; i < 14; i++) this.gems.push({ x: e.x + rand(-70, 70), y: e.y + rand(-70, 70), v: 8, big: true, ph: rand(0, TAU) });
      this.gems.push({ x: e.x, y: e.y, heal: true, ph: 0 });
      // the tide recedes: a quiet spell to collect and breathe
      this.breather = 8;
      this.setBanner('THE TIDE RECEDES', '#7ff5ff');
    } else if (e.golden) {
      this.bonusDust += 12;
      this.setBanner('+12 STARDUST', '#ffd27a');
      audio.levelUp();
      for (let i = 0; i < 8; i++) this.gems.push({ x: e.x + rand(-45, 45), y: e.y + rand(-45, 45), v: 5, big: true, ph: rand(0, TAU) });
    } else {
      const drops = e.elite ? 4 : 1;
      for (let i = 0; i < drops; i++) this.gems.push({ x: e.x + rand(-14, 14), y: e.y + rand(-14, 14), v: e.xp, big: e.elite, ph: rand(0, TAU) });
      if (Math.random() < 0.008) this.gems.push({ x: e.x, y: e.y, heal: true, ph: 0 });
    }
    // Stargrave: the dead burst and wound their kin
    if (this.meta.deathBurst && !e.boss && !this._burstGuard) {
      this._burstGuard = true;
      const R = 55 + e.radius;
      for (const o of this.enemies) {
        if (o.dead || o === e) continue;
        if (dist2(e.x, e.y, o.x, o.y) < R * R) this.damageEnemy(o, e.maxHp * 0.12, '#c9a4ff');
      }
      this._burstGuard = false;
      this.particles.spawn({ x: e.x, y: e.y, life: 0.35, size: R, color: '#c9a4ff', mode: 'ring' });
    }
  }

  hurtPlayer(dmg) {
    const p = this.player;
    if (p.iframes > 0 || p.dead) return;
    p.iframes = 0.55;
    p.hp -= dmg;
    audio.hurt();
    this.shake = Math.min(14, this.shake + 6);
    this.flash = { color: '255,90,120', a: 0.28 };
    for (let i = 0; i < 16; i++) this.particles.spawn({ x: p.x, y: p.y - 16, vx: rand(-180, 180), vy: rand(-220, 40), life: rand(0.3, 0.7), size: rand(2, 5), color: '#ff7aa8', mode: 'glow', drag: 0.9 });
    if (p.hp <= 0 && this.meta.cheatDeath && !this._cheated) {
      // Second Wind — refuse to wake, once per dream
      this._cheated = true;
      p.hp = p.maxHp * 0.5;
      p.iframes = 2.2;
      this.flash = { color: '125,255,176', a: 0.45 };
      this.texts.push({ x: p.x, y: p.y - 60, str: 'SECOND WIND', color: '#7dffb0', life: 1.8, vy: -20, size: 20 });
      for (let i = 0; i < 50; i++) {
        const a = (i / 50) * TAU;
        this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(100, 260), vy: Math.sin(a) * rand(100, 260), life: rand(0.5, 1), size: rand(2, 5), color: '#7dffb0', mode: 'star', rotV: rand(-4, 4), drag: 0.9 });
      }
      return;
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      this.paused = true;
      audio.death();
      this.hooks.onGameOver({ time: this.t, kills: this.kills, level: p.level, bonusDust: this.bonusDust });
    }
  }

  // -------------------------------------------------------------- update
  update(dt) {
    this.t += dt;
    const p = this.player;

    // input
    let mx = (this.keys['d'] || this.keys['arrowright'] ? 1 : 0) - (this.keys['a'] || this.keys['arrowleft'] ? 1 : 0);
    let my = (this.keys['s'] || this.keys['arrowdown'] ? 1 : 0) - (this.keys['w'] || this.keys['arrowup'] ? 1 : 0);
    const L = Math.hypot(mx, my);
    if (L > 0) { mx /= L; my /= L; p.facing = mx !== 0 ? Math.sign(mx) : p.facing; }
    p.moving = L > 0;
    p.x += mx * p.speed * dt;
    p.y += my * p.speed * dt;
    p.animT += dt * (p.moving ? 2.2 : 1);
    p.iframes = Math.max(0, p.iframes - dt);
    p.castPulse = Math.max(0, p.castPulse - dt * 3);
    const regen = (p.boons.regen || 0) + (this.meta.regen || 0);
    if (regen) {
      p.regenT += dt;
      if (p.regenT >= 2) { p.regenT = 0; p.hp = Math.min(p.maxHp, p.hp + regen); }
    }
    // ambient sparkle trail while moving
    if (p.moving && Math.random() < 0.5) {
      this.particles.spawn({ x: p.x + rand(-8, 8), y: p.y + rand(-2, 6), vx: rand(-12, 12), vy: rand(-30, -6), life: rand(0.4, 0.9), size: rand(1.5, 3.5), color: pick(['#b48cff', '#7ff5ff', '#ffd27a']), mode: 'glow', drag: 0.96 });
    }

    this.updateSpawning(dt);
    this.castSpells(dt);

    // enemies
    const d = this.difficulty();
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.animT += dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.slowT = Math.max(0, e.slowT - dt);
      const slowMul = e.slowT > 0 ? 1 - e.slow : 1;
      // golden wisp: flees, never attacks, escapes when its time runs out
      if (e.golden) {
        e.goldT -= dt;
        if (e.goldT <= 0) { e.dead = true; continue; }
        const fa = Math.atan2(e.y - p.y, e.x - p.x) + Math.sin(e.animT * 4 + e.seed) * 0.6;
        e.x += (Math.cos(fa) * e.speed + e.knbx) * dt;
        e.y += (Math.sin(fa) * e.speed + e.knby) * dt;
        e.knbx *= Math.pow(0.02, dt);
        e.knby *= Math.pow(0.02, dt);
        if (Math.random() < 0.5) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-20, 20), vy: rand(-40, -10), life: rand(0.4, 0.8), size: rand(2, 4), color: '#ffd27a', mode: 'star', rotV: rand(-5, 5), drag: 0.94 });
        continue;
      }
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      const wob = Math.sin(e.animT * 3 + e.seed) * 0.4;
      const rangedDef = !e.boss && ENEMY_TYPES[e.type].ranged;
      if (rangedDef) {
        // hover at range: advance when far, retreat when crowded, strafe between
        const D = Math.sqrt(dist2(e.x, e.y, p.x, p.y));
        let moveA = a;
        let sp = e.speed;
        if (D > rangedDef.range) moveA = a;
        else if (D < rangedDef.range * 0.55) moveA = a + Math.PI;
        else { moveA = a + Math.PI / 2 * (e.seed > 500 ? 1 : -1); sp *= 0.5; }
        e.x += (Math.cos(moveA) * sp * slowMul + e.knbx) * dt;
        e.y += (Math.sin(moveA) * sp * slowMul + e.knby) * dt;
        e._shootCd = (e._shootCd == null ? rand(0.5, rangedDef.cd) : e._shootCd) - dt;
        if (e._shootCd <= 0 && D < rangedDef.range * 1.15 && e.slowT <= 0) {
          e._shootCd = rangedDef.cd * rand(0.85, 1.15);
          audio.enemyShot();
          const shots = rangedDef.shots;
          for (let si = 0; si < shots; si++) {
            const sa = a + (shots > 1 ? (si - (shots - 1) / 2) * 0.28 : rand(-0.05, 0.05));
            this.bossProjectiles.push({
              x: e.x, y: e.y - 8,
              vx: Math.cos(sa) * rangedDef.projSpeed,
              vy: Math.sin(sa) * rangedDef.projSpeed,
              life: 7, r: 5, dmg: e.dmg, color: e.color,
            });
          }
        }
      } else {
        e.x += (Math.cos(a + wob * 0.3) * e.speed * slowMul + e.knbx) * dt;
        e.y += (Math.sin(a + wob * 0.3) * e.speed * slowMul + e.knby) * dt;
      }
      e.knbx *= Math.pow(0.02, dt);
      e.knby *= Math.pow(0.02, dt);
      // contact damage
      if (dist2(e.x, e.y, p.x, p.y) < (e.radius + 15) ** 2) this.hurtPlayer(e.dmg);
      // boss bullet-hell
      if (e.boss) {
        e._shootCd = (e._shootCd || 0) - dt;
        if (e._shootCd <= 0) {
          e._shootCd = 1.8 + rand(-0.2, 0.2);
          const count = 6 + Math.floor(this.bossCount * 1.5);
          const spread = TAU / count;
          const baseA = Math.atan2(p.y - e.y, p.x - e.x);
          for (let i = 0; i < count; i++) {
            const a = baseA + (i - count / 2) * spread + rand(-0.08, 0.08);
            this.bossProjectiles.push({
              x: e.x, y: e.y,
              vx: Math.cos(a) * 130,
              vy: Math.sin(a) * 130,
              life: 16,
              r: 6,
            });
          }
        }
      }
      // ambient wisps off elites & boss
      if ((e.elite || e.boss) && Math.random() < 0.3) {
        this.particles.spawn({ x: e.x + rand(-e.radius, e.radius), y: e.y + rand(-e.radius, e.radius), vx: rand(-20, 20), vy: rand(-40, -10), life: rand(0.4, 1), size: rand(2, 5), color: e.boss ? '#c48cff' : '#ffd27a', mode: 'glow', drag: 0.97 });
      }
    }
    // light separation between enemies (cheap, sampled)
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      const j = (i + 1 + ((Math.random() * 4) | 0)) % es.length;
      const o = es[j];
      if (o === e || o.dead) continue;
      const dd = dist2(e.x, e.y, o.x, o.y);
      const minD = e.radius + o.radius;
      if (dd < minD * minD && dd > 0.01) {
        const D = Math.sqrt(dd);
        const push = (minD - D) * 0.5;
        const ux = (e.x - o.x) / D, uy = (e.y - o.y) / D;
        e.x += ux * push; e.y += uy * push;
        o.x -= ux * push; o.y -= uy * push;
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead && dist2(e.x, e.y, p.x, p.y) < 2600 * 2600);

    // boss projectiles
    for (const bp of this.bossProjectiles) {
      bp.life -= dt;
      bp.x += bp.vx * dt;
      bp.y += bp.vy * dt;
      if (bp.life <= 0) continue;
      if (dist2(bp.x, bp.y, p.x, p.y) < (15 + bp.r) ** 2 && p.iframes <= 0) {
        this.hurtPlayer(bp.dmg != null ? bp.dmg : 12 + this.bossCount * 3);
        bp.life = 0;
      }
    }
    this.bossProjectiles = this.bossProjectiles.filter((bp) => bp.life > 0);

    // projectiles
    for (const pr of this.projectiles) {
      if (pr.kind === 'arcane') {
        pr.life -= dt;
        if (!pr.target || pr.target.dead) pr.target = this.nearestEnemy(pr.x, pr.y, 520);
        if (pr.target) {
          const want = Math.atan2(pr.target.y - pr.y, pr.target.x - pr.x);
          const cur = Math.atan2(pr.vy, pr.vx);
          let diff = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
          const na = cur + clamp(diff, -pr.turn * dt, pr.turn * dt);
          const sp = Math.min(pr.speed, Math.hypot(pr.vx, pr.vy) + 800 * dt);
          pr.vx = Math.cos(na) * sp;
          pr.vy = Math.sin(na) * sp;
        }
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-10, 10), vy: rand(-10, 10), life: 0.35, size: rand(3, 6), endSize: 0.5, color: '#b48cff', color2: '#e6d1ff', mode: 'glow' });
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            this.damageEnemy(e, pr.dmg, '#d9beff');
            for (let i = 0; i < 10; i++) this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-170, 170), vy: rand(-170, 170), life: rand(0.2, 0.5), size: rand(2, 4), color: '#e6d1ff', mode: 'star', rotV: rand(-6, 6), drag: 0.86 });
            // Arcane Torrent: splinter into two seeking shards
            if (pr.splinter) {
              for (let k = 0; k < 2; k++) {
                const sa = rand(0, TAU);
                this.projectiles.push({
                  kind: 'arcane', x: pr.x, y: pr.y,
                  vx: Math.cos(sa) * pr.speed * 0.6, vy: Math.sin(sa) * pr.speed * 0.6,
                  speed: pr.speed, dmg: pr.dmg * 0.4, life: 0.9, r: 5,
                  turn: 9, target: this.nearestEnemy(pr.x, pr.y, 420, e), splinter: false,
                });
              }
            }
            pr.life = 0;
            break;
          }
        }
      } else if (pr.kind === 'ember') {
        pr.t += dt;
        const f = Math.min(1, pr.t / pr.dur);
        pr.x = pr.sx + (pr.tx - pr.sx) * f;
        pr.y = pr.sy + (pr.ty - pr.sy) * f - Math.sin(f * Math.PI) * pr.arc;
        this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-14, 14), vy: rand(-10, 40), life: rand(0.25, 0.55), size: rand(3, 7), endSize: 1, color: '#ffd27a', color2: '#ff8c5a', mode: 'glow' });
        if (f >= 1) {
          pr.life = 0;
          this.explode(pr.tx, pr.ty, pr.radius, pr.dmg);
          if (pr.burn) this.zones.push({ kind: 'scorch', x: pr.tx, y: pr.ty, r: pr.radius * 0.75, life: 2.5, maxLife: 2.5, dps: pr.burn.dps, tick: 0, c1: pr.burn.c1, c2: pr.burn.c2, seed: rand(0, TAU) });
        } else pr.life = 1;
      } else if (pr.kind === 'comet') {
        if (pr.x0 == null) { pr.x0 = pr.x - pr.tx; pr.y0 = pr.y - pr.ty; }
        pr.t += dt;
        const f = Math.min(1, pr.t / pr.dur);
        pr.x = pr.tx + pr.x0 * (1 - f);
        pr.y = pr.ty + pr.y0 * (1 - f);
        this.particles.spawn({ x: pr.x + rand(-4, 4), y: pr.y + rand(-4, 4), vx: rand(-15, 15), vy: rand(-30, 10), life: rand(0.3, 0.6), size: rand(3, 7), endSize: 1, color: '#ffb3f2', color2: '#8a7bff', mode: 'glow' });
        if (f >= 1) {
          pr.life = 0;
          this.explode(pr.tx, pr.ty, pr.radius, pr.dmg, { ring: '#ffb3f2', core: '#ffffff', sparks: ['#ffb3f2', '#c48cff', '#8a7bff'], text: '#ffc9f5' });
          if (pr.burn) this.zones.push({ kind: 'scorch', x: pr.tx, y: pr.ty, r: pr.radius * 0.75, life: 2.5, maxLife: 2.5, dps: pr.burn.dps, tick: 0, c1: pr.burn.c1, c2: pr.burn.c2, seed: rand(0, TAU) });
        } else pr.life = 1;
      } else if (pr.kind === 'fang') {
        pr.life -= dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        if (Math.random() < 0.7) this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-12, 12), vy: rand(-12, 12), life: 0.3, size: rand(3, 6), endSize: 0.5, color: '#8a5cd9', color2: '#20123d', mode: 'smoke' });
        for (const e of this.enemies) {
          if (e.dead || pr.hit.has(e)) continue;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            pr.hit.add(e);
            this.damageEnemy(e, pr.dmg, '#c9a4ff');
            if (pr.chill && !e.boss) { e.slow = Math.max(e.slow, 0.35); e.slowT = Math.max(e.slowT, 1); }
            for (let i = 0; i < 6; i++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-130, 130), vy: rand(-130, 130), life: rand(0.2, 0.45), size: rand(2, 4), color: '#8a5cd9', mode: 'glow', drag: 0.86 });
          }
        }
      } else if (pr.kind === 'glaive') {
        pr.life -= dt;
        pr.spin += dt * 14;
        const p2 = this.player;
        if (!pr.returning) {
          pr.x += Math.cos(pr.a) * pr.speed * dt;
          pr.y += Math.sin(pr.a) * pr.speed * dt;
          pr.travelled += pr.speed * dt;
          if (pr.travelled >= pr.range) pr.returning = true;
        } else {
          const D = Math.hypot(p2.x - pr.x, p2.y - pr.y - 20) || 1;
          if (D < 30) {
            pr.life = 0;
            // Star Sovereign: the returning glaive bursts into stardust
            if (pr.evolved) this.explode(p2.x, p2.y - 20, 110, pr.dmg * 1.2, { ring: '#9fd8ff', core: '#e8f6ff', sparks: ['#9fd8ff', '#e8f6ff', '#ffffff'], text: '#bfe4ff', quiet: true });
            continue;
          }
          pr.x += ((p2.x - pr.x) / D) * pr.speed * 1.15 * dt;
          pr.y += ((p2.y - 20 - pr.y) / D) * pr.speed * 1.15 * dt;
        }
        // crystalline shard wake — distinct from arcane's soft glow-orbs
        if (Math.random() < 0.85) this.particles.spawn({ x: pr.x + rand(-3, 3), y: pr.y + rand(-3, 3), vx: rand(-25, 25), vy: rand(-25, 25), life: rand(0.3, 0.6), size: rand(2.5, 5), endSize: 0.5, color: '#e8f6ff', color2: '#9fd8ff', mode: 'shard', rotV: rand(-10, 10), drag: 0.93 });
        for (const e of this.enemies) {
          if (e.dead) continue;
          if ((pr.hitCd[e.seed] || 0) > this.t) continue;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            pr.hitCd[e.seed] = this.t + 0.45;
            this.damageEnemy(e, pr.dmg, '#bfe4ff');
            for (let i = 0; i < 5; i++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-120, 120), vy: rand(-120, 120), life: rand(0.2, 0.4), size: rand(2, 4), color: '#bfe4ff', mode: 'star', rotV: rand(-6, 6), drag: 0.88 });
          }
        }
      } else if (pr.kind === 'lantern') {
        pr.life -= dt;
        pr.ph += dt * 5;
        if (!pr.target || pr.target.dead) pr.target = this.nearestEnemy(pr.x, pr.y, 460);
        if (pr.target) {
          const D = Math.hypot(pr.target.x - pr.x, pr.target.y - pr.y) || 1;
          pr.vx += ((pr.target.x - pr.x) / D) * 340 * dt;
          pr.vy += ((pr.target.y - pr.y) / D) * 340 * dt;
        }
        const sp = Math.hypot(pr.vx, pr.vy) || 1;
        if (sp > pr.speed) { pr.vx = (pr.vx / sp) * pr.speed; pr.vy = (pr.vy / sp) * pr.speed; }
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt + Math.sin(pr.ph) * 8 * dt;
        if (Math.random() < 0.6) this.particles.spawn({ x: pr.x, y: pr.y + 4, vx: rand(-8, 8), vy: rand(-24, -6), life: rand(0.3, 0.7), size: rand(2, 4), color: '#a8ffe8', mode: 'glow', drag: 0.95 });
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            pr.life = 0;
            this.explode(pr.x, pr.y, pr.radius, pr.dmg, { ring: '#a8ffe8', core: '#e8fff8', sparks: ['#a8ffe8', '#4ad9c4', '#7dffb0'], text: '#a8ffe8', quiet: true });
            break;
          }
        }
      }
    }
    this.projectiles = this.projectiles.filter((pr) => pr.life > 0);

    // zones
    for (const z of this.zones) {
      z.life -= dt;
      if (z.delay && z.delay > 0) { z.delay -= dt; z.life += dt; continue; }
      if (z.kind === 'frostwave') {
        const f = 1 - z.life / z.maxLife;
        z.r = 10 + (z.maxR - 10) * f;
        for (const e of this.enemies) {
          if (e.dead || z.hit.has(e)) continue;
          if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) {
            z.hit.add(e);
            this.damageEnemy(e, z.dmg, '#bff1ff');
            if (!e.boss) {
              e.slow = z.slow;
              e.slowT = z.slowDur;
            }
            for (let i = 0; i < 6; i++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-60, 60), vy: rand(-90, -20), life: rand(0.4, 0.8), size: rand(3, 6), color: '#bff1ff', mode: 'shard', rotV: rand(-4, 4), drag: 0.93 });
          }
        }
      } else if (z.kind === 'rift') {
        z.spin += dt * 3.2;
        z.tick -= dt;
        // Event Horizon: the rift collapses in a burst when it closes
        if (z.evolved && z.life <= 0 && !z.boomed) {
          z.boomed = true;
          this.explode(z.x, z.y, z.r * 1.3, z.dps * 3, { ring: '#9a5cff', core: '#e6d1ff', sparks: ['#9a5cff', '#ff9ad5', '#c9a4ff'], text: '#c9a4ff', quiet: true });
        }
        // swirl particles inward
        for (let i = 0; i < 3; i++) {
          const a = rand(0, TAU);
          const R = z.r * rand(0.9, 1.4);
          const px = z.x + Math.cos(a) * R, py = z.y + Math.sin(a) * R;
          this.particles.spawn({ x: px, y: py, vx: (z.x - px) * 1.6 + -Math.sin(a) * 90, vy: (z.y - py) * 1.6 + Math.cos(a) * 90, life: rand(0.4, 0.8), size: rand(2, 5), color: Math.random() < 0.5 ? '#9a5cff' : '#ff9ad5', mode: 'glow', drag: 0.97 });
        }
        for (const e of this.enemies) {
          if (e.dead || (e.boss && !z.evolved)) continue;
          const dd = dist2(z.x, z.y, e.x, e.y);
          if (dd < (z.r * 1.6) ** 2 && dd > 4) {
            const D = Math.sqrt(dd);
            const pull = z.pull * (e.boss ? 0.35 : 1);
            e.x += ((z.x - e.x) / D) * pull * dt;
            e.y += ((z.y - e.y) / D) * pull * dt;
          }
        }
        if (z.tick <= 0) {
          z.tick = 0.25;
          for (const e of this.enemies) {
            if (e.dead) continue;
            if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) this.damageEnemy(e, z.dps * 0.25, '#c9a4ff');
          }
        }
      } else if (z.kind === 'nebula') {
        if (z.evolved) {
          // Genesis Cloud follows its maker
          const D = Math.hypot(p.x - z.x, p.y - z.y) || 1;
          if (D > 40) { z.x += ((p.x - z.x) / D) * 42 * dt; z.y += ((p.y - z.y) / D) * 42 * dt; }
        } else {
          z.x += z.dvx * dt;
          z.y += z.dvy * dt;
        }
        z.tick -= dt;
        // slow star-mist sparkle inside, plus glints orbiting the rim so the
        // true edge stays readable without an outline
        for (let i = 0; i < 2; i++) {
          const a = rand(0, TAU), R = z.r * Math.sqrt(Math.random());
          this.particles.spawn({ x: z.x + Math.cos(a) * R, y: z.y + Math.sin(a) * R, vx: rand(-14, 14), vy: rand(-18, -4), life: rand(0.5, 1.1), size: rand(1.5, 4), color: pick(['#c48cff', '#ff9ad5', '#ffd9f2']), mode: Math.random() < 0.3 ? 'star' : 'glow', rotV: rand(-3, 3), drag: 0.97 });
        }
        if (Math.random() < 0.8) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: z.x + Math.cos(a) * z.r * rand(0.93, 1.0), y: z.y + Math.sin(a) * z.r * rand(0.93, 1.0), vx: -Math.sin(a) * 30, vy: Math.cos(a) * 30, life: rand(0.6, 1.2), size: rand(1.2, 2.6), color: pick(['#e3bfff', '#ffd9f2']), mode: 'glow', drag: 0.99 });
        }
        if (z.tick <= 0) {
          z.tick = 0.3;
          for (const e of this.enemies) {
            if (e.dead) continue;
            if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) this.damageEnemy(e, z.dps * 0.3, '#e3bfff');
          }
        }
      } else if (z.kind === 'sigil') {
        if (z.life <= 0) {
          // detonate: damage + sleep
          audio.sigilBoom();
          this.shake = Math.min(10, this.shake + 3);
          this.particles.spawn({ x: z.x, y: z.y, life: 0.45, size: z.r * 1.3, color: '#ffd27a', mode: 'ring' });
          for (let i = 0; i < 40; i++) {
            const a = rand(0, TAU);
            this.particles.spawn({ x: z.x, y: z.y, vx: Math.cos(a) * rand(60, 320), vy: Math.sin(a) * rand(60, 320), life: rand(0.3, 0.8), size: rand(2, 6), color: pick(['#ffd27a', '#b48cff', '#fff2cc']), mode: 'star', rotV: rand(-6, 6), drag: 0.88 });
          }
          for (const e of this.enemies) {
            if (e.dead) continue;
            if (dist2(z.x, z.y, e.x, e.y) < (z.r + e.radius) ** 2) {
              this.damageEnemy(e, z.dmg, '#ffe9bd');
              if (!e.boss) { e.slow = 0.92; e.slowT = z.sleepDur; }
            }
          }
          // The Great Seal sounds twice
          if (z.echo && !z.echoed) { z.echoed = true; z.life = 0.9; }
        }
      } else if (z.kind === 'scorch') {
        z.tick -= dt;
        if (Math.random() < 0.6) {
          const a = rand(0, TAU), R = z.r * Math.sqrt(Math.random());
          this.particles.spawn({ x: z.x + Math.cos(a) * R, y: z.y + Math.sin(a) * R, vx: rand(-8, 8), vy: rand(-45, -15), life: rand(0.3, 0.7), size: rand(2, 5), endSize: 0.5, color: z.c1, color2: z.c2, mode: 'glow', drag: 0.94 });
        }
        if (z.tick <= 0) {
          z.tick = 0.3;
          for (const e of this.enemies) {
            if (e.dead) continue;
            if (dist2(z.x, z.y, e.x, e.y) < (z.r + e.radius) ** 2) this.damageEnemy(e, z.dps * 0.3, z.c2);
          }
        }
      } else if (z.kind === 'novawave') {
        const f = 1 - z.life / z.maxLife;
        z.r = 10 + (z.maxR - 10) * f;
        for (const e of this.enemies) {
          if (e.dead || z.hit.has(e)) continue;
          if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) {
            z.hit.add(e);
            this.damageEnemy(e, z.dmg, '#ffbfe4');
            if (!e.boss) {
              const a = Math.atan2(e.y - z.y, e.x - z.x);
              e.knbx += Math.cos(a) * z.knock;
              e.knby += Math.sin(a) * z.knock;
            }
          }
        }
      }
    }
    this.zones = this.zones.filter((z) => z.life > 0);

    // beams
    for (const b of this.beams) {
      b.life -= dt;
      if (b.sweep) b.a += b.sweep * dt;
      const ca = Math.cos(b.a), sa = Math.sin(b.a);
      for (const e of this.enemies) {
        if (e.dead || b.hit.has(e)) continue;
        // point-line distance within beam length
        const ex = e.x - b.x, ey = e.y - b.y;
        const proj = ex * ca + ey * sa;
        if (proj < 0 || proj > b.len) continue;
        const perp = Math.abs(-ex * sa + ey * ca);
        if (perp < b.w * 0.5 + e.radius) {
          b.hit.add(e);
          this.damageEnemy(e, b.dmg, '#fff3b8');
          for (let i = 0; i < 8; i++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-140, 140), vy: rand(-140, 140), life: rand(0.25, 0.55), size: rand(2, 5), color: '#fff3b8', mode: 'star', rotV: rand(-8, 8), drag: 0.88 });
        }
      }
      // moondust along the lance
      for (let i = 0; i < 4; i++) {
        const dPos = rand(0, b.len);
        this.particles.spawn({ x: b.x + ca * dPos + rand(-6, 6), y: b.y + sa * dPos + rand(-6, 6), vx: rand(-20, 20), vy: rand(-40, -5), life: rand(0.4, 0.9), size: rand(1.5, 4), color: pick(['#fff3b8', '#bcd9ff']), mode: 'glow', drag: 0.96 });
      }
    }
    this.beams = this.beams.filter((b) => b.life > 0);

    // bolts fade
    for (const b of this.bolts) b.life -= dt;
    this.bolts = this.bolts.filter((b) => b.life > 0);

    // gems
    const mr = this.magnetR();
    for (const g of this.gems) {
      g.ph += dt * 4;
      const dd = dist2(g.x, g.y, p.x, p.y);
      if (dd < mr * mr) {
        const D = Math.sqrt(dd) || 1;
        const pullSp = 260 + (mr - D) * 6;
        g.x += ((p.x - g.x) / D) * pullSp * dt;
        g.y += ((p.y - g.y) / D) * pullSp * dt;
      }
      if (dd < 26 * 26) {
        g.taken = true;
        if (g.heal) {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
          this.texts.push({ x: p.x, y: p.y - 40, str: '+life', color: '#7dffb0', life: 0.8, vy: -40, size: 14 });
        } else {
          this.gainXp(g.v);
          audio.gem();
        }
        for (let i = 0; i < 8; i++) this.particles.spawn({ x: g.x, y: g.y, vx: rand(-90, 90), vy: rand(-120, -20), life: rand(0.3, 0.6), size: rand(2, 4), color: g.heal ? '#7dffb0' : '#7ff5ff', mode: 'glow', drag: 0.9 });
      }
    }
    this.gems = this.gems.filter((g) => !g.taken);
    if (this.gems.length > 400) this.gems.splice(0, this.gems.length - 400);

    // fallen stars (map pickups)
    this.starTimer -= dt;
    if (this.starTimer <= 0) {
      this.starTimer = rand(75, 110);
      const a = rand(0, TAU);
      this.pickups.push({
        x: p.x + Math.cos(a) * rand(650, 900), y: p.y + Math.sin(a) * rand(650, 900),
        life: 20, ph: rand(0, TAU), kind: pick(['heal', 'gems', 'dust']),
      });
      this.setBanner('A STAR HAS FALLEN NEARBY', '#7ff5ff');
    }
    for (const s of this.pickups) {
      s.life -= dt;
      s.ph += dt * 3;
      if (dist2(s.x, s.y, p.x, p.y) < 34 * 34) {
        s.taken = true;
        audio.levelUp();
        if (s.kind === 'heal') {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.35);
          this.texts.push({ x: p.x, y: p.y - 44, str: '+life', color: '#7dffb0', life: 1, vy: -40, size: 16 });
        } else if (s.kind === 'gems') {
          const d2 = this.difficulty();
          const v = Math.max(2, Math.round(3 * d2.hpMul));
          for (let i = 0; i < 10; i++) this.gems.push({ x: s.x + rand(-60, 60), y: s.y + rand(-60, 60), v, big: true, ph: rand(0, TAU) });
        } else {
          this.bonusDust += 10;
          this.texts.push({ x: p.x, y: p.y - 44, str: '+10 stardust', color: '#ffd27a', life: 1, vy: -40, size: 16 });
        }
        for (let i = 0; i < 40; i++) {
          const a2 = rand(0, TAU);
          this.particles.spawn({ x: s.x, y: s.y, vx: Math.cos(a2) * rand(80, 320), vy: Math.sin(a2) * rand(80, 320), life: rand(0.4, 0.9), size: rand(2, 5), color: '#7ff5ff', color2: '#ffd27a', mode: 'star', rotV: rand(-6, 6), drag: 0.9 });
        }
      }
    }
    this.pickups = this.pickups.filter((s) => !s.taken && s.life > 0);

    // banner
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }

    // texts
    for (const t of this.texts) { t.life -= dt; t.y += t.vy * dt; }
    this.texts = this.texts.filter((t) => t.life > 0);

    this.particles.update(dt);

    // camera
    this.cam.x += (p.x - this.cam.w / 2 - this.cam.x) * Math.min(1, dt * 6);
    this.cam.y += (p.y - this.cam.h / 2 - this.cam.y) * Math.min(1, dt * 6);
    this.shake = Math.max(0, this.shake - dt * 30);
    if (this.flash) { this.flash.a -= dt * 1.2; if (this.flash.a <= 0) this.flash = null; }

    // hud sync ~10hz
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) { this.hudTimer = 0.1; this.pushHud(); }
  }

  explode(x, y, radius, dmg, pal = null) {
    if (!pal || !pal.quiet) audio.fireBoom();
    this.shake = Math.min(12, this.shake + (pal && pal.quiet ? 1.5 : 4));
    const textCol = pal ? pal.text : '#ffbe8a';
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dd = dist2(x, y, e.x, e.y);
      if (dd < (radius + e.radius) ** 2) {
        this.damageEnemy(e, dmg, textCol);
      }
    }
    const ring = pal ? pal.ring : '#ffd27a';
    const core = pal ? pal.core : '#ffffff';
    const sparks = pal ? pal.sparks : ['#ffd27a', '#ff8c5a', '#ff5a7a'];
    this.particles.spawn({ x, y, life: 0.45, size: radius * 1.25, color: ring, mode: 'ring' });
    this.particles.spawn({ x, y, life: 0.3, size: radius * 0.8, color: core, color2: sparks[0], mode: 'glow' });
    const n = pal && pal.quiet ? 24 : 44;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      this.particles.spawn({ x, y, vx: Math.cos(a) * rand(60, 380), vy: Math.sin(a) * rand(60, 380) - 40, life: rand(0.35, 0.95), size: rand(2.5, 7), endSize: 0.5, color: pick(sparks), color2: '#5a2a10', mode: 'glow', ay: 160, drag: 0.9 });
    }
    for (let i = 0; i < 8; i++) this.particles.spawn({ x, y, vx: rand(-40, 40), vy: rand(-70, -20), life: rand(0.7, 1.3), size: rand(14, 26), endSize: 34, color: 'rgba(70,40,90,0.55)', mode: 'smoke', drag: 0.95 });
  }

  pushHud(force = false) {
    const p = this.player;
    this.hooks.onHud({
      hp: p.hp, maxHp: p.maxHp, xp: p.xp, xpNext: p.xpNext, level: p.level,
      time: this.t, kills: this.kills,
      spells: p.spells.map((s) => ({ id: s.id, level: s.level, evolved: !!s.evolved })),
      boons: { ...p.boons },
      dust: dustForRun({ kills: this.kills, level: p.level, time: this.t, bonusDust: this.bonusDust }, this.meta),
      paused: this.paused,
    }, force);
  }

  // ================================================================ rendering
  render() {
    const ctx = this.ctx;
    const { w, h } = this.cam;
    const camX = this.cam.x;
    const camY = this.cam.y;
    const cam = { x: camX, y: camY, w, h };

    // dreamscape sky
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#0b0a1e');
    sky.addColorStop(0.5, '#141031');
    sky.addColorStop(1, '#1c1140');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // parallax stars
    ctx.save();
    for (let li = 0; li < this.stars.length; li++) {
      const par = 0.12 + li * 0.1;
      ctx.fillStyle = ['#5b6bb5', '#8fa0e8', '#cdd8ff'][li];
      for (const s of this.stars[li]) {
        const sx = ((s.x - camX * par) % 2000 + 2000) % 2000 - (2000 - w) / 2;
        const sy = ((s.y - camY * par) % 2000 + 2000) % 2000 - (2000 - h) / 2;
        if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue;
        const tw = 0.5 + 0.5 * Math.sin(this.t * 2 + s.tw);
        ctx.globalAlpha = 0.25 + tw * 0.5;
        ctx.fillRect(sx, sy, s.s, s.s);
      }
    }
    ctx.restore();

    // drifting motes
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      const par = 0.55;
      const mx = ((m.x - camX * par + Math.sin(this.t * 0.3 + m.ph) * 30) % 1800 + 1800) % 1800 - (1800 - w) / 2;
      const my = ((m.y - camY * par - this.t * m.sp) % 1800 + 1800) % 1800 - (1800 - h) / 2;
      if (mx < -10 || my < -10 || mx > w + 10 || my > h + 10) continue;
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(this.t + m.ph);
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, m.r * 3);
      g.addColorStop(0, m.hue);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(mx, my, m.r * 3, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // zones (under entities)
    for (const z of this.zones) this.drawZone(ctx, cam, z);

    // gems
    for (const g of this.gems) this.drawGem(ctx, cam, g);

    // fallen stars
    for (const s of this.pickups) this.drawPickup(ctx, cam, s);

    // enemies
    for (const e of this.enemies) this.drawEnemy(ctx, cam, e);

    // player
    this.drawPlayer(ctx, cam);

    // orbitals
    this.drawOrbitals(ctx, cam);

    // projectiles
    for (const pr of this.projectiles) this.drawProjectile(ctx, cam, pr);

    // boss projectiles
    for (const bp of this.bossProjectiles) this.drawBossProjectile(ctx, cam, bp);

    // beams & bolts
    for (const b of this.beams) this.drawBeam(ctx, cam, b);
    for (const b of this.bolts) this.drawBolt(ctx, cam, b);

    // particles above all entities
    this.particles.draw(ctx, cam);

    // damage texts
    ctx.save();
    ctx.textAlign = 'center';
    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `700 ${t.size}px Cinzel, serif`;
      ctx.fillStyle = t.color;
      ctx.shadowColor = t.color;
      ctx.shadowBlur = 8;
      ctx.fillText(t.str, t.x - cam.x, t.y - cam.y);
    }
    ctx.restore();

    // vignette
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(5,3,18,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // edge arrows toward off-screen fallen stars
    for (const s of this.pickups) {
      const sx = s.x - camX, sy = s.y - camY;
      if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) continue;
      const ax = clamp(sx, 46, w - 46), ay = clamp(sy, 46, h - 46);
      const ang = Math.atan2(sy - ay, sx - ax);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.globalAlpha = 0.55 + 0.3 * Math.sin(this.t * 5);
      ctx.fillStyle = '#7ff5ff';
      ctx.shadowColor = '#7ff5ff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -8);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // event banner
    if (this.banner) {
      const b = this.banner;
      const a = Math.min(1, b.life, (b.maxLife - b.life) * 3);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '700 24px Cinzel, serif';
      ctx.fillStyle = b.color;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 18;
      ctx.fillText(b.str, w / 2, 118);
      ctx.restore();
    }

    if (this.flash) {
      ctx.fillStyle = `rgba(${this.flash.color},${Math.max(0, this.flash.a)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  drawPickup(ctx, cam, s) {
    const x = s.x - cam.x, y = s.y - cam.y;
    if (x < -60 || y < -60 || x > cam.w + 60 || y > cam.h + 60) return;
    const urgent = s.life < 5 ? 0.5 + 0.5 * Math.sin(this.t * 10) : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = urgent;
    // beacon column
    const beam = ctx.createLinearGradient(x, y - 190, x, y);
    beam.addColorStop(0, 'rgba(127,245,255,0)');
    beam.addColorStop(1, 'rgba(127,245,255,0.3)');
    ctx.fillStyle = beam;
    ctx.fillRect(x - 7, y - 190, 14, 190);
    // ground ring
    ctx.strokeStyle = '#7ff5ff';
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.5 * urgent;
    ctx.beginPath();
    ctx.ellipse(x, y + 6, 22 + Math.sin(s.ph) * 3, 8, 0, 0, TAU);
    ctx.stroke();
    // the star itself
    ctx.globalAlpha = urgent;
    const g = ctx.createRadialGradient(x, y - 8, 0, x, y - 8, 26);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.4, '#7ff5ff');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y - 8, 26, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#eafeff';
    ctx.save();
    ctx.translate(x, y - 8);
    ctx.rotate(s.ph * 0.6);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU - Math.PI / 2;
      const a2 = a + TAU / 10;
      ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
      ctx.lineTo(Math.cos(a2) * 4.2, Math.sin(a2) * 4.2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  drawGem(ctx, cam, g) {
    const x = g.x - cam.x, y = g.y - cam.y + Math.sin(g.ph) * 3;
    if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    const c = g.heal ? '#7dffb0' : g.big ? '#ffd27a' : '#7ff5ff';
    const s = g.heal ? 9 : g.big ? 8 : 5.5;
    const gl = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 2.4);
    gl.addColorStop(0, c);
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(0, 0, s * 2.4, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(g.ph * 0.5);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.62, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.62, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.5);
    ctx.lineTo(s * 0.26, 0);
    ctx.lineTo(0, s * 0.5);
    ctx.lineTo(-s * 0.26, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawZone(ctx, cam, z) {
    const x = z.x - cam.x, y = z.y - cam.y;
    if (z.kind === 'frostwave') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const t = z.life / z.maxLife;
      ctx.globalAlpha = t;
      ctx.strokeStyle = '#bff1ff';
      ctx.lineWidth = 6;
      ctx.shadowColor = '#8fe8ff';
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(x, y, z.r, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, z.r * 0.86, 0, TAU);
      ctx.stroke();
      ctx.restore();
    } else if (z.kind === 'rift') {
      ctx.save();
      const fade = Math.min(1, z.life * 2, (z.maxLife - z.life) * 3);
      ctx.globalAlpha = fade;
      // dark heart
      const g = ctx.createRadialGradient(x, y, 0, x, y, z.r);
      g.addColorStop(0, 'rgba(10,4,25,0.95)');
      g.addColorStop(0.55, 'rgba(43,16,80,0.75)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, z.r, 0, TAU);
      ctx.fill();
      // spiral arms
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#9a5cff';
      ctx.shadowColor = '#9a5cff';
      ctx.shadowBlur = 16;
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const f = i / 24;
          const a = z.spin + arm * (TAU / 3) + f * 2.6;
          const R = z.r * (1 - f) * 0.95;
          const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
      // event-horizon ring
      ctx.strokeStyle = '#ff9ad5';
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, z.r * 0.32 + Math.sin(this.t * 6) * 2, 0, TAU);
      ctx.stroke();
      ctx.restore();
    } else if (z.kind === 'nebula') {
      ctx.save();
      const fade = Math.min(1, z.life * 1.5, (z.maxLife - z.life) * 2);
      ctx.globalAlpha = fade * 0.8;
      ctx.globalCompositeOperation = 'lighter';
      // base mist that fills the true radius, so the range reads at a glance:
      // dense body, soft but quick falloff right at the edge
      const base = ctx.createRadialGradient(x, y, 0, x, y, z.r);
      base.addColorStop(0, 'rgba(158,110,230,0.16)');
      base.addColorStop(0.72, 'rgba(158,110,230,0.14)');
      base.addColorStop(0.92, 'rgba(196,140,255,0.07)');
      base.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(x, y, z.r, 0, TAU);
      ctx.fill();
      // breathing lobes of brighter star-mist drifting inside it
      for (let i = 0; i < 3; i++) {
        const aa = z.seed + i * 2.1 + this.t * 0.3;
        const lx = x + Math.cos(aa) * z.r * 0.28;
        const ly = y + Math.sin(aa) * z.r * 0.28;
        const lr = z.r * (0.55 + 0.08 * Math.sin(this.t * 1.4 + i * 2));
        const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
        g.addColorStop(0, ['rgba(196,140,255,0.2)', 'rgba(255,154,213,0.16)', 'rgba(138,123,255,0.18)'][i]);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(lx, ly, lr, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    } else if (z.kind === 'sigil') {
      ctx.save();
      const f = 1 - z.life / z.maxLife; // arming progress
      const pulse = 0.5 + 0.5 * Math.sin(this.t * (6 + f * 18));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 + f * 0.5;
      ctx.strokeStyle = '#ffd27a';
      ctx.shadowColor = '#ffd27a';
      ctx.shadowBlur = 14 + pulse * 10;
      ctx.lineWidth = 2;
      // outer circle + rotating inner triangle rune
      ctx.beginPath();
      ctx.arc(x, y, z.r * (0.4 + f * 0.6), 0, TAU);
      ctx.stroke();
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.t * 1.5);
      const rr = z.r * 0.45 * (0.4 + f * 0.6) / 1;
      ctx.strokeStyle = '#b48cff';
      ctx.beginPath();
      for (let k = 0; k <= 3; k++) {
        const aa = (k / 3) * TAU - Math.PI / 2;
        k === 0 ? ctx.moveTo(Math.cos(aa) * rr, Math.sin(aa) * rr) : ctx.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
      }
      ctx.stroke();
      // moon glyph at center
      ctx.strokeStyle = '#fff2cc';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0.6, TAU - 0.6);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    } else if (z.kind === 'scorch') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const fade = Math.min(1, z.life * 1.2, (z.maxLife - z.life) * 4);
      const flick = 0.85 + 0.15 * Math.sin(this.t * 9 + z.seed);
      ctx.globalAlpha = 0.2 * fade * flick;
      const g = ctx.createRadialGradient(x, y, 0, x, y, z.r);
      g.addColorStop(0, z.c1);
      g.addColorStop(0.7, z.c2);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, z.r, 0, TAU);
      ctx.fill();
      ctx.restore();
    } else if (z.kind === 'novawave') {
      if (z.delay && z.delay > 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const t = z.life / z.maxLife;
      ctx.globalAlpha = t;
      ctx.strokeStyle = '#ff9ad5';
      ctx.lineWidth = 8;
      ctx.shadowColor = '#ff9ad5';
      ctx.shadowBlur = 26;
      ctx.beginPath();
      ctx.arc(x, y, z.r, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = '#5a2a6e';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, z.r * 0.9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawProjectile(ctx, cam, pr) {
    const x = pr.x - cam.x, y = pr.y - cam.y;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (pr.kind === 'arcane') {
      const a = Math.atan2(pr.vy, pr.vx);
      ctx.translate(x, y);
      ctx.rotate(a);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.4, '#b48cff');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e6d1ff';
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-8, 4.4);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, -4.4);
      ctx.closePath();
      ctx.fill();
    } else if (pr.kind === 'ember') {
      const g = ctx.createRadialGradient(x, y, 0, x, y, 16);
      g.addColorStop(0, '#fff6d8');
      g.addColorStop(0.4, '#ffd27a');
      g.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, TAU);
      ctx.fill();
    } else if (pr.kind === 'comet') {
      // landing marker: a soft contracting ring where the star will strike
      const f = Math.min(1, pr.t / pr.dur);
      const mx = pr.tx - cam.x, my = pr.ty - cam.y;
      ctx.save();
      ctx.globalAlpha = 0.25 + f * 0.45;
      ctx.strokeStyle = '#ffb3f2';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(mx, my, 26 - f * 14, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,179,242,0.5)';
      ctx.beginPath();
      ctx.arc(mx, my, 2.5, 0, TAU);
      ctx.fill();
      ctx.restore();
      // streaking star with a long tail
      const a = Math.atan2(pr.ty - pr.y || 1, pr.tx - pr.x || 0.4);
      ctx.translate(x, y);
      ctx.rotate(a);
      const tail = ctx.createLinearGradient(-70, 0, 10, 0);
      tail.addColorStop(0, 'rgba(138,123,255,0)');
      tail.addColorStop(1, 'rgba(255,179,242,0.75)');
      ctx.fillStyle = tail;
      ctx.beginPath();
      ctx.moveTo(-70, 0);
      ctx.lineTo(4, -6);
      ctx.lineTo(4, 6);
      ctx.closePath();
      ctx.fill();
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 15);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.4, '#ffb3f2');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, TAU);
      ctx.fill();
    } else if (pr.kind === 'fang') {
      const a = Math.atan2(pr.vy, pr.vx);
      ctx.translate(x, y);
      ctx.rotate(a);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
      g.addColorStop(0, 'rgba(138,92,217,0.85)');
      g.addColorStop(1, 'rgba(32,18,61,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, TAU);
      ctx.fill();
      // crescent blade
      ctx.fillStyle = '#c9a4ff';
      ctx.beginPath();
      ctx.arc(0, 0, 12, -1.25, 1.25);
      ctx.arc(-5, 0, 10, 1.05, -1.05, true);
      ctx.closePath();
      ctx.fill();
    } else if (pr.kind === 'glaive') {
      // a spinning double-crescent blade — crisp edges, no round glow-orb,
      // so it never reads as an arcane missile
      const moveA = pr.returning
        ? Math.atan2(this.player.y - 20 - pr.y, this.player.x - pr.x)
        : pr.a;
      ctx.translate(x, y);
      // motion streak behind the blade
      ctx.save();
      ctx.rotate(moveA);
      const streak = ctx.createLinearGradient(-56, 0, 0, 0);
      streak.addColorStop(0, 'rgba(159,216,255,0)');
      streak.addColorStop(1, 'rgba(232,246,255,0.55)');
      ctx.fillStyle = streak;
      ctx.fillRect(-56, -3, 56, 6);
      ctx.restore();
      ctx.rotate(pr.spin);
      ctx.shadowColor = '#9fd8ff';
      ctx.shadowBlur = 10;
      // two mirrored sickle blades around a small hub
      for (const side of [0, Math.PI]) {
        ctx.save();
        ctx.rotate(side);
        ctx.fillStyle = '#e8f6ff';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.quadraticCurveTo(20, -16, 30, -4);
        ctx.quadraticCurveTo(19, -6, 8, 4);
        ctx.closePath();
        ctx.fill();
        // cold blue edge line
        ctx.strokeStyle = '#9fd8ff';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(8, 1);
        ctx.quadraticCurveTo(20, -7, 30, -4);
        ctx.stroke();
        ctx.restore();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 3.4, 0, TAU);
      ctx.fill();
    } else if (pr.kind === 'lantern') {
      const flick = 0.8 + Math.sin(pr.ph * 3) * 0.2;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 16 * flick);
      g.addColorStop(0, '#e8fff8');
      g.addColorStop(0.4, '#a8ffe8');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 16 * flick, 0, TAU);
      ctx.fill();
      // little inner flame
      ctx.fillStyle = '#4ad9c4';
      ctx.beginPath();
      ctx.ellipse(x, y, 3, 4.5 + Math.sin(pr.ph * 5), 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawBeam(ctx, cam, b) {
    const t = b.life / b.maxLife;
    const x = b.x - cam.x, y = b.y - cam.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.a);
    ctx.globalCompositeOperation = 'lighter';
    const wNow = b.w * (0.4 + 0.6 * Math.sin(t * Math.PI));
    const g = ctx.createLinearGradient(0, -wNow, 0, wNow);
    g.addColorStop(0, 'rgba(255,243,184,0)');
    g.addColorStop(0.5, `rgba(255,250,225,${0.85 * t + 0.1})`);
    g.addColorStop(1, 'rgba(188,217,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, -wNow, b.len, wNow * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.9 * t})`;
    ctx.fillRect(0, -wNow * 0.18, b.len, wNow * 0.36);
    // crescent at origin
    ctx.strokeStyle = '#fff3b8';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#fff3b8';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(0, 0, 18, b.a * 0 + 0.6, TAU - 0.6);
    ctx.stroke();
    ctx.restore();
  }

  drawBolt(ctx, cam, b) {
    const t = b.life / b.maxLife;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = t;
    for (const [lw, col, blur] of [[5, 'rgba(122,215,255,0.5)', 18], [2, '#ffffff', 6]]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.shadowColor = '#7ad7ff';
      ctx.shadowBlur = blur;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      b.pts.forEach((p, i) => {
        const x = p.x - cam.x, y = p.y - cam.y;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  drawOrbitals(ctx, cam) {
    const s = this.player.spells.find((s) => s.id === 'petals');
    if (!s) return;
    ctx.save();
    for (const o of this.orbitals) {
      const x = o.x - cam.x, y = o.y - cam.y;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(o.a * 2);
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
      g.addColorStop(0, 'rgba(125,255,176,0.8)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // a five-petal spirit blossom
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k % 2 ? '#ffd1ec' : '#7dffb0';
        ctx.save();
        ctx.rotate((k / 5) * TAU);
        ctx.beginPath();
        ctx.ellipse(0, -7, 3.2, 6.4, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath();
      ctx.arc(0, 0, 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  drawBossProjectile(ctx, cam, bp) {
    // enemy shots get a unique silhouette — a jagged dark dart with a red
    // core — so threats never read like friendly sparkles
    if (bp.life <= 0) return;
    const x = bp.x - cam.x, y = bp.y - cam.y;
    if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
    const a = Math.atan2(bp.vy, bp.vx);
    const s = bp.r / 6; // scale relative to the old 6px radius
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    // hot red halo (small, so the dark body still silhouettes)
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14 * s);
    g.addColorStop(0, 'rgba(255,60,70,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 14 * s, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // jagged dark dart body with a pale rim
    ctx.scale(s, s);
    ctx.fillStyle = '#1a0a14';
    ctx.strokeStyle = 'rgba(255,190,200,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(2, -3);
    ctx.lineTo(-2, -6);
    ctx.lineTo(-4, -2);
    ctx.lineTo(-9, 0);
    ctx.lineTo(-4, 2);
    ctx.lineTo(-2, 6);
    ctx.lineTo(2, 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // burning red core
    ctx.fillStyle = '#ff2e44';
    ctx.shadowColor = '#ff2e44';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0.5, 0, 2.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---- entity drawing: composed shape "sprites" with idle/walk animation
  drawPlayer(ctx, cam) {
    const p = this.player;
    const x = p.x - cam.x, y = p.y - cam.y;
    const bob = Math.sin(p.animT * 6) * (p.moving ? 3 : 1.4);
    const sway = Math.sin(p.animT * 6 + 1) * (p.moving ? 0.08 : 0.03);
    const blink = p.iframes > 0 && Math.sin(this.t * 40) > 0;
    ctx.save();
    ctx.translate(x, y);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 8, 18, 6, 0, 0, TAU);
    ctx.fill();

    if (blink) ctx.globalAlpha = 0.45;
    ctx.scale(p.facing, 1);
    ctx.translate(0, bob * -1);
    ctx.rotate(sway);

    // robe — layered, with wavy hem
    const hemT = p.animT * 8;
    const robe = (w1, w2, hY, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-w1, -26);
      ctx.quadraticCurveTo(-w2 - 2, -6, -w2, hY);
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        ctx.lineTo(-w2 + f * w2 * 2, hY + Math.sin(hemT + f * 9) * 2.2);
      }
      ctx.quadraticCurveTo(w2 + 2, -6, w1, -26);
      ctx.closePath();
      ctx.fill();
    };
    robe(9, 16, 8, '#241a4d');
    robe(8, 13, 5, '#3b2a78');
    // belt & moon sigil
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(-8, -14, 16, 2.4);
    ctx.strokeStyle = '#8fe8ff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -4, 4.4, 0.7, TAU - 0.7);
    ctx.stroke();

    // head
    ctx.fillStyle = '#f2d9c0';
    ctx.beginPath();
    ctx.arc(1, -32, 6.5, 0, TAU);
    ctx.fill();
    // eyes (tiny, looking ahead)
    ctx.fillStyle = '#1a1330';
    ctx.beginPath();
    ctx.arc(3.4, -33, 1, 0, TAU);
    ctx.fill();

    // hat: wide brim + bent cone with star
    const hatBend = Math.sin(p.animT * 3) * 1.5;
    ctx.fillStyle = '#2c1f63';
    ctx.beginPath();
    ctx.ellipse(0.5, -36, 13.5, 3.6, -0.06, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3b2a78';
    ctx.beginPath();
    ctx.moveTo(-7.5, -37);
    ctx.quadraticCurveTo(-3, -52, 2 + hatBend, -56);
    ctx.quadraticCurveTo(7 + hatBend, -58, 4 + hatBend, -50);
    ctx.quadraticCurveTo(7, -44, 8, -37.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffd27a';
    ctx.save();
    ctx.translate(3.5 + hatBend, -54);
    ctx.rotate(this.t * 1.5);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU - Math.PI / 2;
      const a2 = a + TAU / 10;
      ctx.lineTo(Math.cos(a) * 3, Math.sin(a) * 3);
      ctx.lineTo(Math.cos(a2) * 1.3, Math.sin(a2) * 1.3);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // staff arm + staff with pulsing orb
    ctx.strokeStyle = '#f2d9c0';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(4, -22);
    ctx.lineTo(13, -26);
    ctx.stroke();
    ctx.strokeStyle = '#6b4a2a';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(14, 6);
    ctx.quadraticCurveTo(15.5, -20, 14, -44);
    ctx.stroke();
    const pulse = 5 + Math.sin(this.t * 5) * 1.2 + p.castPulse * 6;
    ctx.globalCompositeOperation = 'lighter';
    const og = ctx.createRadialGradient(14, -48, 0, 14, -48, pulse * 2.4);
    og.addColorStop(0, '#ffffff');
    og.addColorStop(0.35, '#7ff5ff');
    og.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = og;
    ctx.beginPath();
    ctx.arc(14, -48, pulse * 2.4, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#bff9ff';
    ctx.beginPath();
    ctx.arc(14, -48, 3.6, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  drawEnemy(ctx, cam, e) {
    const x = e.x - cam.x, y = e.y - cam.y;
    if (x < -80 || y < -80 || x > cam.w + 80 || y > cam.h + 80) return;
    const p = this.player;
    ctx.save();
    ctx.translate(x, y);
    const flash = e.hitFlash > 0;
    const frozen = e.slowT > 0;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, e.radius * 0.55, e.radius * 0.85, e.radius * 0.3, 0, 0, TAU);
    ctx.fill();

    if (e.elite || e.golden) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,210,122,0.6)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffd27a';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(0, 0, e.radius + 8 + Math.sin(this.t * 4) * 2, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    const bodyTint = flash ? '#ffffff' : frozen ? mixHint(e.color) : e.golden ? '#ffe9a8' : null;
    const sc = e.boss ? e.radius / 18 : e.radius / ENEMY_TYPES[e.type].radius;
    ctx.scale(sc, sc);

    switch (e.type) {
      case 'wisp': this.drawWisp(ctx, e, bodyTint); break;
      case 'bat': this.drawBat(ctx, e, bodyTint); break;
      case 'eye': this.drawEye(ctx, e, bodyTint, p); break;
      case 'shade': this.drawShade(ctx, e, bodyTint); break;
      case 'golem': this.drawGolem(ctx, e, bodyTint); break;
      case 'siren': this.drawSiren(ctx, e, bodyTint, p); break;
      case 'warlock': this.drawWarlock(ctx, e, bodyTint); break;
    }
    ctx.restore();

    // health bar for hurt / big enemies
    if (e.hp < e.maxHp && (e.elite || e.boss || e.maxHp > 40)) {
      const bw = e.boss ? 90 : 30;
      ctx.fillStyle = 'rgba(10,8,26,0.8)';
      ctx.fillRect(x - bw / 2, y - e.radius - 14, bw, 4);
      ctx.fillStyle = e.boss ? '#ff9ad5' : '#7ff5ff';
      ctx.fillRect(x - bw / 2, y - e.radius - 14, (bw * e.hp) / e.maxHp, 4);
    }
  }

  drawWisp(ctx, e, tint) {
    const fl = Math.sin(e.animT * 9 + e.seed);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
    g.addColorStop(0, tint || '#dffcff');
    g.addColorStop(0.45, '#7ff5ff');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.fill();
    // three flame tongues licking upward
    ctx.fillStyle = tint || 'rgba(190,250,255,0.85)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 6 - 3, 2);
      ctx.quadraticCurveTo(i * 7 + fl * 3, -14 - Math.abs(i) * -4, i * 6 + fl * 4, -20 - fl * 3 + Math.abs(i) * 6);
      ctx.quadraticCurveTo(i * 8 + 3, -8, i * 6 + 3, 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // core body + sleepy eyes
    ctx.fillStyle = tint || '#eafeff';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#0b2a3a';
    const blink = Math.sin(e.animT * 1.3 + e.seed) > 0.92 ? 0.2 : 1;
    ctx.beginPath();
    ctx.ellipse(-3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.ellipse(3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.fill();
  }

  drawBat(ctx, e, tint) {
    const flap = Math.sin(e.animT * 14 + e.seed);
    const hover = Math.sin(e.animT * 5) * 2;
    ctx.translate(0, hover);
    // wings: membrane with two struts each
    ctx.fillStyle = tint || '#5b3a9e';
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.rotate(-flap * 0.55);
      ctx.beginPath();
      ctx.moveTo(4, -2);
      ctx.quadraticCurveTo(16, -14, 26, -6);
      ctx.quadraticCurveTo(20, -1, 22, 5);
      ctx.quadraticCurveTo(15, 2, 14, 8);
      ctx.quadraticCurveTo(9, 4, 4, 6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = tint || '#7a55c9';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(5, 0); ctx.lineTo(24, -5);
      ctx.moveTo(5, 2); ctx.lineTo(15, 6);
      ctx.stroke();
      ctx.restore();
    }
    // body + ears
    ctx.fillStyle = tint || '#7a55c9';
    ctx.beginPath();
    ctx.ellipse(0, 0, 7.5, 9.5, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-5, -7); ctx.lineTo(-6.5, -14); ctx.lineTo(-1.5, -9);
    ctx.moveTo(5, -7); ctx.lineTo(6.5, -14); ctx.lineTo(1.5, -9);
    ctx.closePath();
    ctx.fill();
    // glowing eyes + tiny fangs
    ctx.fillStyle = '#ff5a7a';
    ctx.shadowColor = '#ff5a7a';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(-2.8, -2, 1.5, 0, TAU);
    ctx.arc(2.8, -2, 1.5, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-2, 4); ctx.lineTo(-1, 7); ctx.lineTo(0, 4);
    ctx.moveTo(2, 4); ctx.lineTo(1, 7); ctx.lineTo(0, 4);
    ctx.fill();
  }

  drawEye(ctx, e, tint, p) {
    const hover = Math.sin(e.animT * 3 + e.seed) * 3;
    ctx.translate(0, hover);
    const blinkPh = (e.animT + e.seed) % 3.4;
    const lid = blinkPh > 3.2 ? 1 - (blinkPh - 3.2) / 0.1 : blinkPh < 0.1 ? blinkPh / 0.1 : 1;
    // cilia tentacles
    ctx.strokeStyle = tint || '#c76ba3';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + e.animT * 0.4;
      const wig = Math.sin(e.animT * 6 + i * 2) * 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 14, Math.sin(a) * 14);
      ctx.quadraticCurveTo(Math.cos(a) * 22 + wig, Math.sin(a) * 22, Math.cos(a) * 27 + wig, Math.sin(a) * 27 - 2);
      ctx.stroke();
    }
    if (e.boss) {
      // crown of floating shards
      ctx.fillStyle = '#c48cff';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + this.t * 0.8;
        const R = 30 + Math.sin(this.t * 2 + i) * 3;
        ctx.save();
        ctx.translate(Math.cos(a) * R, Math.sin(a) * R * 0.6 - 14);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, -6); ctx.lineTo(3, 0); ctx.lineTo(0, 6); ctx.lineTo(-3, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // eyeball
    ctx.fillStyle = tint || '#fdeef6';
    ctx.save();
    ctx.scale(1, Math.max(0.08, lid));
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, TAU);
    ctx.fill();
    // iris tracks player
    const a = Math.atan2(p.y - e.y, p.x - e.x);
    const ix = Math.cos(a) * 5, iy = Math.sin(a) * 5;
    const ig = ctx.createRadialGradient(ix, iy, 0, ix, iy, 8);
    ig.addColorStop(0, '#ff9ad5');
    ig.addColorStop(1, '#8a2a5e');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ix, iy, 7.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1a0a14';
    ctx.beginPath();
    ctx.arc(ix, iy, 3.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(ix - 2, iy - 2.4, 1.4, 0, TAU);
    ctx.fill();
    ctx.restore();
    // veins
    ctx.strokeStyle = 'rgba(200,80,120,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-13, -4); ctx.quadraticCurveTo(-8, -2, -7, 2);
    ctx.moveTo(12, 5); ctx.quadraticCurveTo(8, 3, 7, -1);
    ctx.stroke();
  }

  drawShade(ctx, e, tint) {
    const wave = e.animT * 5 + e.seed;
    ctx.globalAlpha = 0.92;
    // trailing wisp smoke
    ctx.fillStyle = 'rgba(60,40,120,0.35)';
    ctx.beginPath();
    ctx.ellipse(-Math.sin(wave) * 4, 12, 12, 5, 0, 0, TAU);
    ctx.fill();
    // cloak with waving hem
    const grad = ctx.createLinearGradient(0, -22, 0, 16);
    grad.addColorStop(0, tint || '#4a3a96');
    grad.addColorStop(1, tint || '#1c1440');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.quadraticCurveTo(14, -18, 13, 0);
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      ctx.lineTo(13 - f * 26, 8 + Math.sin(wave + f * 8) * 4 - f * 2);
    }
    ctx.quadraticCurveTo(-14, -18, 0, -24);
    ctx.fill();
    // hood hollow + eyes
    ctx.fillStyle = '#0a0618';
    ctx.beginPath();
    ctx.ellipse(0, -14, 6.5, 7.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#9a8cff';
    ctx.shadowColor = '#9a8cff';
    ctx.shadowBlur = 8;
    const squint = 1 + Math.sin(e.animT * 2) * 0.3;
    ctx.beginPath();
    ctx.ellipse(-2.6, -14, 1.5, 2 * squint, 0.2, 0, TAU);
    ctx.ellipse(2.6, -14, 1.5, 2 * squint, -0.2, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    // skeletal hands reaching
    ctx.strokeStyle = '#cfd0ee';
    ctx.lineWidth = 1.8;
    const reach = Math.sin(wave * 0.7) * 2;
    ctx.beginPath();
    ctx.moveTo(9, -8); ctx.lineTo(15, -4 + reach);
    ctx.moveTo(15, -4 + reach); ctx.lineTo(17, -6 + reach);
    ctx.moveTo(15, -4 + reach); ctx.lineTo(18, -3 + reach);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawGolem(ctx, e, tint) {
    const breathe = Math.sin(e.animT * 2 + e.seed) * 1.5;
    // orbiting rock chunks
    ctx.fillStyle = tint || '#3a5e8a';
    for (let i = 0; i < 4; i++) {
      const a = e.animT * 1.2 + (i / 4) * TAU;
      const R = 26 + Math.sin(e.animT * 3 + i) * 2;
      ctx.save();
      ctx.translate(Math.cos(a) * R, Math.sin(a) * R * 0.5 - 6);
      ctx.rotate(a);
      ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
      ctx.restore();
    }
    // crystalline torso — irregular polygon
    const body = ctx.createLinearGradient(0, -20, 0, 16);
    body.addColorStop(0, tint || '#7fb7d9');
    body.addColorStop(1, tint || '#2a4a72');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -22 - breathe);
    ctx.lineTo(14, -10);
    ctx.lineTo(18, 6);
    ctx.lineTo(8, 14);
    ctx.lineTo(-8, 14);
    ctx.lineTo(-18, 6);
    ctx.lineTo(-14, -10);
    ctx.closePath();
    ctx.fill();
    // glowing rune cracks
    ctx.strokeStyle = '#8fe8ff';
    ctx.shadowColor = '#8fe8ff';
    ctx.shadowBlur = 6 + breathe * 2;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-6, -12); ctx.lineTo(-2, -4); ctx.lineTo(-7, 4);
    ctx.moveTo(6, -10); ctx.lineTo(3, 0); ctx.lineTo(9, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // single glowing eye slit
    ctx.fillStyle = '#bff9ff';
    ctx.shadowColor = '#bff9ff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.ellipse(0, -14 - breathe * 0.5, 6, 1.8 + Math.sin(e.animT * 4) * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  drawSiren(ctx, e, tint, p) {
    // a drowned dream-singer: hovering, trailing veils, mouth-glow when charging
    const hover = Math.sin(e.animT * 4 + e.seed) * 3;
    ctx.translate(0, hover);
    const charging = e._shootCd != null && e._shootCd < 0.6;
    // flowing veils
    ctx.fillStyle = tint || 'rgba(125,201,255,0.4)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 4, -6);
      ctx.quadraticCurveTo(side * 16, 2 + Math.sin(e.animT * 5 + side) * 3, side * 10, 14);
      ctx.quadraticCurveTo(side * 6, 6, side * 2, 8);
      ctx.closePath();
      ctx.fill();
    }
    // body — teardrop
    const g = ctx.createLinearGradient(0, -16, 0, 12);
    g.addColorStop(0, tint || '#bfe4ff');
    g.addColorStop(1, tint || '#3a6ea8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.quadraticCurveTo(9, -6, 7, 6);
    ctx.quadraticCurveTo(4, 13, 0, 14);
    ctx.quadraticCurveTo(-4, 13, -7, 6);
    ctx.quadraticCurveTo(-9, -6, 0, -16);
    ctx.fill();
    // singing mouth: glows as it charges a note
    ctx.fillStyle = charging ? '#eaf7ff' : '#0b2a3a';
    if (charging) { ctx.shadowColor = '#7dc9ff'; ctx.shadowBlur = 10 + Math.sin(this.t * 20) * 4; }
    ctx.beginPath();
    ctx.ellipse(0, -2, 2.4, 3.4 + (charging ? 1.5 : 0), 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    // closed dreaming eyes
    ctx.strokeStyle = '#0b2a3a';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(-3.4, -8, 1.8, 0.2, Math.PI - 0.2);
    ctx.arc(3.4, -8, 1.8, 0.2, Math.PI - 0.2);
    ctx.stroke();
    // note motes drifting toward the player when charging
    if (charging && Math.random() < 0.4) {
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      this.particles.spawn({ x: e.x, y: e.y - 4, vx: Math.cos(a) * 40 + rand(-15, 15), vy: Math.sin(a) * 40 - 20, life: 0.5, size: rand(1.5, 3), color: '#7dc9ff', mode: 'glow', drag: 0.95 });
    }
  }

  drawWarlock(ctx, e, tint) {
    // hooded caster with a floating grimoire and triple orb halo
    const bob = Math.sin(e.animT * 3 + e.seed) * 2;
    ctx.translate(0, bob);
    // robe
    const grad = ctx.createLinearGradient(0, -20, 0, 16);
    grad.addColorStop(0, tint || '#7a3aa8');
    grad.addColorStop(1, tint || '#2a1040');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.quadraticCurveTo(13, -14, 12, 2);
    ctx.quadraticCurveTo(14, 12, 8, 14);
    ctx.lineTo(-8, 14);
    ctx.quadraticCurveTo(-14, 12, -12, 2);
    ctx.quadraticCurveTo(-13, -14, 0, -22);
    ctx.fill();
    // hood hollow with baleful eyes
    ctx.fillStyle = '#12081f';
    ctx.beginPath();
    ctx.ellipse(0, -13, 6, 7, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ff9ad5';
    ctx.shadowColor = '#ff9ad5';
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.arc(-2.4, -13, 1.3, 0, TAU);
    ctx.arc(2.4, -13, 1.3, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    // floating grimoire
    const pf = Math.sin(e.animT * 6) * 0.15;
    ctx.save();
    ctx.translate(12, -4 + Math.sin(e.animT * 4) * 2);
    ctx.rotate(-0.3 + pf);
    ctx.fillStyle = '#3d2159';
    ctx.fillRect(-5, -3.5, 10, 7);
    ctx.fillStyle = '#e3bfff';
    ctx.fillRect(-4, -2.5, 4, 5);
    ctx.fillRect(0.5, -2.5, 3.5, 5);
    ctx.restore();
    // orbiting charge-orbs, brighter as the volley nears
    const charge = e._shootCd != null ? clamp(1 - e._shootCd / 1.2, 0, 1) : 0;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = e.animT * 2.4 + (i / 3) * TAU;
      const ox = Math.cos(a) * 17, oy = Math.sin(a) * 8 - 22;
      const og = ctx.createRadialGradient(ox, oy, 0, ox, oy, 5 + charge * 4);
      og.addColorStop(0, '#ffd9f2');
      og.addColorStop(1, 'rgba(217,140,255,0)');
      ctx.fillStyle = og;
      ctx.beginPath();
      ctx.arc(ox, oy, 5 + charge * 4, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function mixHint(base) {
  void base;
  return '#bfe9ff';
}

// Long-run probe: does player DPS keep up with the unbounded HP multiplier?
// Instruments true post-crit damage dealt (via damageEnemy delta) alongside
// the enemy HP multiplier, live count, and player HP, out to 20 minutes.
import { setupEnv } from './env.mjs';
setupEnv();

const { Engine } = await import('../src/game/engine.js');
const meta = await import('../src/game/meta.js');
const { TREE_NODES, canBuy, buyNode, computeBonuses } = meta;

function buildMeta({ dust = 0, shards = 0, priority = [], dark = false } = {}) {
  let m = { dust, shards, owned: ['core'], best: 0 };
  const wants = (id) => {
    for (let i = 0; i < priority.length; i++) if (id.startsWith(priority[i])) return i;
    return dark && id.startsWith('dark-') ? priority.length + 1 : priority.length + 5;
  };
  let guard = 0;
  while (guard++ < 4000) {
    const buyable = TREE_NODES.filter((n) => canBuy(m, n.id));
    if (!buyable.length) break;
    buyable.sort((a, b) => (wants(a.id) - wants(b.id)) || (a.cost - b.cost));
    m = buyNode(m, buyable[0].id);
  }
  return m;
}

function pickChoice(choices) {
  const score = (c) => {
    if (c.kind === 'evolve') return 100;
    if (c.kind === 'spell' && c.isNew) return 80;
    if (c.kind === 'boon' && c.id === 'vitality') return 60;
    if (c.kind === 'boon' && c.id === 'power') return 55;
    if (c.kind === 'boon' && c.id === 'haste') return 50;
    if (c.kind === 'spell' && c.mastery) return 30;
    if (c.kind === 'spell') return 45;
    if (c.kind === 'boon') return 40;
    if (c.kind === 'generic') return 20;
    return 10;
  };
  return [...choices].sort((a, b) => score(b) - score(a))[0];
}

function driveKeys(engine) {
  const p = engine.player;
  let fx = 0, fy = 0;
  for (const e of engine.enemies) {
    if (e.dead || e.golden) continue;
    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 300 * 300 || d2 < 1) continue;
    const w = (e.boss ? 5 : e.elite ? 2.2 : 1) / d2;
    fx += dx * w; fy += dy * w;
  }
  for (const bp of engine.bossProjectiles) {
    const dx = p.x - bp.x, dy = p.y - bp.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 150 * 150 || d2 < 1) continue;
    fx += dx * (3 / d2); fy += dy * (3 / d2);
  }
  let gnx = 0, gny = 0, gbest = Infinity;
  for (const g of engine.gems) {
    if (g.taken) continue;
    const dx = g.x - p.x, dy = g.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < gbest) { gbest = d2; gnx = dx; gny = dy; }
  }
  const fmag = Math.hypot(fx, fy);
  if (fmag < 1e-6 && gbest < Infinity) { fx = gnx; fy = gny; }
  else if (gbest < 220 * 220) { const gl = Math.hypot(gnx, gny) || 1; fx += (gnx / gl) * 0.0006; fy += (gny / gl) * 0.0006; }
  const ang = Math.atan2(fy, fx);
  const k = engine.keys;
  k.w = k.a = k.s = k.d = false;
  if (fmag < 1e-9 && gbest === Infinity) return;
  if (Math.cos(ang) > 0.38) k.d = true;
  if (Math.cos(ang) < -0.38) k.a = true;
  if (Math.sin(ang) > 0.38) k.s = true;
  if (Math.sin(ang) < -0.38) k.w = true;
}

function runOnce(metaBonuses, maxT, sampleEvery) {
  let result = null;
  const engine = new Engine({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, width: 0, height: 0 }, {
    onHud: () => {}, onLevelUp: () => {}, onGameOver: (r) => { result = r; }, getMeta: () => metaBonuses,
  });
  engine.reset();
  engine.particles = { spawn: () => {}, update: () => {}, draw: () => {} };
  engine.paused = false;
  // instrument true post-crit damage dealt
  let dmgAccum = 0;
  const origDmg = engine.damageEnemy.bind(engine);
  engine.damageEnemy = (e, dmg, color) => { const before = e.hp; origDmg(e, dmg, color); if (!e.golden) dmgAccum += Math.max(0, before - e.hp); };

  const dt = 1 / 60;
  let t = 0, nextSample = sampleEvery, lastKills = 0, lastT = 0, lastDmg = 0;
  const samples = [];
  while (!result && t < maxT) {
    let guard = 0;
    while (engine._levelUpActive && guard++ < 200) engine.chooseUpgrade(pickChoice(engine._choices));
    if (result) break;
    driveKeys(engine);
    if (!engine.paused) engine.update(dt);
    t += dt;
    if (t >= nextSample) {
      const p = engine.player;
      const span = t - lastT || 1;
      samples.push({
        t: Math.round(t), lvl: p.level, hpPct: Math.round((p.hp / p.maxHp) * 100),
        alive: engine.enemies.length, kps: Math.round((engine.kills - lastKills) / span),
        dps: Math.round((dmgAccum - lastDmg) / span), hpMul: +engine.difficulty().hpMul.toFixed(1),
        mastery: p.spells.reduce((s, sp) => s + (sp.mastery || 0), 0),
      });
      lastKills = engine.kills; lastDmg = dmgAccum; lastT = t; nextSample += sampleEvery;
    }
  }
  return { died: !!result, deathT: result ? +result.time.toFixed(0) : null, samples };
}

function fmt(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }

const CONFIGS = [
  ['Mid (~4000)', buildMeta({ dust: 4000, priority: ['might', 'vital', 'tempo', 'arcane', 'ember'] })],
  ['Heavy (~20000)', buildMeta({ dust: 20000, priority: ['might', 'vital', 'tempo', 'cosmos', 'arcane', 'ember', 'storm', 'moon'] })],
  ['Whale (~80000)', buildMeta({ dust: 80000, priority: ['might', 'tempo', 'cosmos', 'vital', 'fate', 'tides', 'arcane', 'ember', 'storm', 'moon', 'void'] })],
];

const MAXT = 1200, EVERY = 60, RUNS = 3;
for (const [name, m] of CONFIGS) {
  const b = computeBonuses(m);
  console.log(`\n=== ${name} ===  dmg+${b.dmg}% haste+${b.cast} aoe+${b.aoe}% hp+${b.hp} crit+${b.crit}% masteryPlus+${b.masteryPlus || 0}`);
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(runOnce(b, MAXT, EVERY));
  const deaths = runs.filter((r) => r.died).map((r) => fmt(r.deathT));
  console.log(`  deaths: ${deaths.length ? deaths.join(', ') : 'none — survived full 20:00'} (${runs.filter(r=>r.died).length}/${RUNS})`);
  // print the run that went longest (or a median) as the representative timeline
  const rep = runs.slice().sort((a, b) => (b.samples.at(-1)?.t || 0) - (a.samples.at(-1)?.t || 0))[Math.floor(RUNS / 2)];
  console.log(`   t     lvl  hp%  alive  kills/s   dps    hpMul  mastery   dps/hpMul`);
  for (const s of rep.samples) {
    const eff = Math.round(s.dps / s.hpMul);
    const mark = s.t === 900 ? ' <15m' : s.t === 1200 ? ' <20m' : '';
    console.log(`  ${String(s.t).padStart(4)}  ${String(s.lvl).padStart(3)}  ${String(s.hpPct).padStart(3)}  ${String(s.alive).padStart(4)}   ${String(s.kps).padStart(5)}  ${String(s.dps).padStart(6)}   ${String(s.hpMul).padStart(5)}  ${String(s.mastery).padStart(5)}   ${String(eff).padStart(6)}${mark}`);
  }
}

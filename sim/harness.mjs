// Headless balance harness — drives the real Engine.update() loop with a
// kiting bot + auto-picker. No rendering, no audio. Metrics only.
import { setupEnv } from './env.mjs';
setupEnv();

const { Engine } = await import('../src/game/engine.js');
const meta = await import('../src/game/meta.js');
const { NODE_MAP, TREE_NODES, canBuy, buyNode, computeBonuses, dustForRun } = meta;

// ------------------------------------------------------------------ meta builder
// Emulate a player who has invested `budget` stardust (+ `shards`) by greedily
// buying reachable nodes along a priority of arms/clusters.
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
    // prefer wanted arms, then cheapest
    buyable.sort((a, b) => (wants(a.id) - wants(b.id)) || (a.cost - b.cost));
    const pick = buyable[0];
    // stop spending dust on non-priority filler once priorities are exhausted
    m = buyNode(m, pick.id);
  }
  return m;
}

// ------------------------------------------------------------------ auto-picker
// A damage-leaning build: grab evolutions, fill to 6 spells, then deepen.
function pickChoice(choices, engine) {
  const score = (c) => {
    if (c.kind === 'evolve') return 100;
    if (c.kind === 'spell' && c.isNew) return 80;
    if (c.kind === 'boon' && c.id === 'vitality') return 60;
    if (c.kind === 'boon' && c.id === 'power') return 55;
    if (c.kind === 'boon' && c.id === 'haste') return 50;
    if (c.kind === 'spell' && c.mastery) return 30;
    if (c.kind === 'spell') return 45; // level an existing spell
    if (c.kind === 'boon') return 40;
    if (c.kind === 'generic') return 20;
    return 10;
  };
  return [...choices].sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------------ kiting bot
function driveKeys(engine) {
  const p = engine.player;
  let fx = 0, fy = 0;
  // repel from threats
  for (const e of engine.enemies) {
    if (e.dead || e.golden) continue;
    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 300 * 300 || d2 < 1) continue;
    const w = (e.boss ? 5 : e.elite ? 2.2 : 1) / d2;
    fx += dx * w; fy += dy * w;
  }
  // dodge incoming bullets
  for (const bp of engine.bossProjectiles) {
    const dx = p.x - bp.x, dy = p.y - bp.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 150 * 150 || d2 < 1) continue;
    fx += dx * (3 / d2); fy += dy * (3 / d2);
  }
  // mild pull toward nearest gem when it's safe-ish
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
  // map to 8-way keys
  const ang = Math.atan2(fy, fx);
  const k = engine.keys;
  k.w = k.a = k.s = k.d = false;
  if (fmag < 1e-9 && gbest === Infinity) return; // stand still
  if (Math.cos(ang) > 0.38) k.d = true;
  if (Math.cos(ang) < -0.38) k.a = true;
  if (Math.sin(ang) > 0.38) k.s = true;
  if (Math.sin(ang) < -0.38) k.w = true;
}

// ------------------------------------------------------------------ one run
function runOnce(metaBonuses, maxT = 600) {
  let result = null;
  const engine = new Engine({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, width: 0, height: 0 }, {
    onHud: () => {},
    onLevelUp: () => {},
    onGameOver: (r) => { result = r; },
    getMeta: () => metaBonuses,
  });
  engine.reset();
  engine.particles = { spawn: () => {}, update: () => {}, draw: () => {} };
  engine.paused = false;

  const dt = 1 / 60;
  let t = 0;
  const samples = [];
  let nextSample = 0;
  let lastKills = 0, lastSampleT = 0;
  while (!result && t < maxT) {
    let guard = 0;
    while (engine._levelUpActive && guard++ < 100) {
      engine.chooseUpgrade(pickChoice(engine._choices, engine));
    }
    if (result) break;
    driveKeys(engine);
    if (!engine.paused) engine.update(dt);
    t += dt;
    if (t >= nextSample) {
      const p = engine.player;
      const dk = engine.kills - lastKills;
      const dtS = t - lastSampleT || 1;
      samples.push({ t: Math.round(t), lvl: p.level, hpPct: Math.round((p.hp / p.maxHp) * 100), kills: engine.kills, alive: engine.enemies.length, kps: +(dk / dtS).toFixed(1), maxHp: Math.round(p.maxHp) });
      lastKills = engine.kills; lastSampleT = t; nextSample += 30;
    }
  }
  const p = engine.player;
  const r = result || { time: t, kills: engine.kills, level: p.level, bonusDust: engine.bonusDust, shards: engine.shardsEarned };
  const dust = dustForRun(r, metaBonuses);
  return { time: +r.time.toFixed(1), kills: r.kills, level: r.level, dust, shards: r.shards || 0, samples, survivedCap: !result };
}

function runConfig(name, m, runs = 3) {
  const bonuses = computeBonuses(m);
  const owned = m.owned.length - 1;
  const results = [];
  for (let i = 0; i < runs; i++) results.push(runOnce(bonuses));
  const avg = (f) => (results.reduce((s, r) => s + f(r), 0) / results.length);
  console.log(`\n=== ${name} ===`);
  console.log(`  nodes owned: ${owned}   key bonuses: dmg+${bonuses.dmg}% haste+${bonuses.cast} aoe+${bonuses.aoe}% hp+${bonuses.hp} crit+${bonuses.crit}% xp+${bonuses.xp}% regen${bonuses.regen} startLv${bonuses.startLv} startSpells[${bonuses.startSpells.join(',')}] echo${bonuses.echo} cheatDeath${bonuses.cheatDeath}`);
  const banes = Object.entries(bonuses).filter(([k, v]) => k.startsWith('bane') && v).map(([k, v]) => `${k}${v}`);
  if (banes.length) console.log(`  banes: ${banes.join(' ')}  dust+${bonuses.dust}%`);
  console.log(`  survival: ${results.map((r) => fmt(r.time)).join(', ')}  (avg ${fmt(avg((r) => r.time))})`);
  console.log(`  level:    ${results.map((r) => r.level).join(', ')}  (avg ${avg((r) => r.level).toFixed(1)})`);
  console.log(`  kills:    ${results.map((r) => r.kills).join(', ')}  (avg ${Math.round(avg((r) => r.kills))})`);
  console.log(`  dust:     ${results.map((r) => r.dust).join(', ')}  (avg ${Math.round(avg((r) => r.dust))})`);
  // print the median run's timeline
  const med = results.slice().sort((a, b) => a.time - b.time)[Math.floor(results.length / 2)];
  console.log(`  timeline (median run, ${fmt(med.time)}):`);
  console.log(`    t     lvl  hp%   kills  alive  kills/s  maxHp`);
  for (const s of med.samples) console.log(`    ${String(s.t).padStart(4)}  ${String(s.lvl).padStart(3)}  ${String(s.hpPct).padStart(3)}   ${String(s.kills).padStart(5)}  ${String(s.alive).padStart(5)}   ${String(s.kps).padStart(5)}  ${String(s.maxHp).padStart(5)}`);
  return { name, owned, avgTime: avg((r) => r.time), avgLevel: avg((r) => r.level), avgKills: avg((r) => r.kills), avgDust: avg((r) => r.dust) };
}

function fmt(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }

// ------------------------------------------------------------------ configs
const configs = [];
configs.push(['Fresh (no constellation)', buildMeta({ dust: 0 })]);
configs.push(['Early invest (~800 dust)', buildMeta({ dust: 800, priority: ['might', 'vital', 'tempo'] })]);
configs.push(['Mid invest (~4000 dust)', buildMeta({ dust: 4000, priority: ['might', 'vital', 'tempo', 'arcane', 'ember'] })]);
configs.push(['Heavy invest (~20000 dust)', buildMeta({ dust: 20000, priority: ['might', 'vital', 'tempo', 'cosmos', 'arcane', 'ember', 'storm', 'moon'] })]);
configs.push(['Whale (~80000 dust)', buildMeta({ dust: 80000, priority: ['might', 'tempo', 'cosmos', 'vital', 'fate', 'tides', 'arcane', 'ember', 'storm', 'moon', 'void'] })]);
configs.push(['Dark Bargain (heavy + all banes)', buildMeta({ dust: 20000, shards: 30, dark: true, priority: ['dark-', 'might', 'vital', 'tempo', 'arcane', 'ember'] })]);

const summary = [];
for (const [name, m] of configs) summary.push(runConfig(name, m, 3));

console.log(`\n\n================ SUMMARY ================`);
console.log(`config                              nodes   survival   level   kills    dust`);
for (const s of summary) {
  console.log(`${s.name.padEnd(34)}  ${String(s.owned).padStart(4)}    ${fmt(s.avgTime).padStart(6)}   ${s.avgLevel.toFixed(1).padStart(5)}   ${String(Math.round(s.avgKills)).padStart(5)}   ${String(Math.round(s.avgDust)).padStart(5)}`);
}

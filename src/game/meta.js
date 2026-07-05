// Meta progression: the Constellation — a persistent skill tree bought with
// stardust earned each run. Stored in localStorage.
//
// Layout: a large central web of general modifiers (6 arms joined by two
// connector rings, keystones deep in the arms) surrounded by 7 satellite
// clusters, each devoted to a pair of kindred spell schools. School nodes
// feed per-spell stat modifiers the engine applies on top of level stats.

const STORE_KEY = 'dreamtide_meta_v2';
const LEGACY_KEY = 'dreamtide_meta_v1';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;

// ---------------------------------------------------------------- schools
export const SCHOOLS = {
  pyre: { name: 'The Burning Court', spells: ['ember', 'starfall'], color: '#ff8c5a', theme: 'ember & star' },
  astral: { name: 'The Silver Orrery', spells: ['arcane', 'glaive'], color: '#b48cff', theme: 'missile & glaive' },
  gale: { name: 'Winter & Storm', spells: ['frost', 'storm'], color: '#7ad7ff', theme: 'frost & lightning' },
  umbral: { name: 'The Umbral Choir', spells: ['void', 'umbra'], color: '#8a5cd9', theme: 'rift & fang' },
  oneiric: { name: 'The Sleeping Nebula', spells: ['nebula', 'sigil'], color: '#c48cff', theme: 'cloud & rune' },
  verdant: { name: 'The Verdant Wake', spells: ['petals', 'lantern'], color: '#7dffb0', theme: 'petal & lantern' },
  dusk: { name: 'Moon & Dusk', spells: ['moon', 'nova'], color: '#fff3b8', theme: 'lance & nova' },
};

// ---------------------------------------------------------------- builders
const nodes = [];
const add = (n) => { nodes.push(n); return n.id; };

add({ id: 'core', x: 0, y: 0, cost: 0, name: 'The Waking Eye', desc: 'Where every dream begins.', fx: {}, kind: 'core', requires: [] });

// ---- central arms: 8 path nodes + a branch keystone + an end keystone
const ARM_RADII = [60, 105, 150, 195, 245, 295, 350, 410];
const ARM_COSTS = [15, 25, 40, 65, 100, 150, 230, 360];

const ARMS = {
  might: {
    angle: -150,
    fx: [
      { name: 'Ember Thought', desc: '+4% spell damage', fx: { dmg: 4 } },
      { name: 'Ember Thought', desc: '+4% spell damage', fx: { dmg: 4 } },
      { name: 'Sharpened Dream', desc: '+5% spell damage', fx: { dmg: 5 } },
      { name: 'Kindled Will', desc: '+10% spell damage', fx: { dmg: 10 }, kind: 'notable' },
      { name: 'Cruel Reverie', desc: '+5% critical chance', fx: { crit: 5 } },
      { name: 'Cruel Reverie', desc: '+5% critical chance', fx: { crit: 5 } },
      { name: 'Deep Focus', desc: '+7% spell damage', fx: { dmg: 7 } },
      { name: 'Red Portent', desc: '+7% crit chance, crits deal +20% more', fx: { crit: 7, critDmg: 20 }, kind: 'notable' },
    ],
    branch: { name: 'Bloodmoon', desc: '+10% crit chance, crits deal +50% more', fx: { crit: 10, critDmg: 50 }, cost: 600 },
    end: { name: 'Overmind', desc: 'Multi-shot spells fire +1 projectile', fx: { extraCount: 1 }, cost: 2600 },
  },
  tempo: {
    angle: -30,
    fx: [
      { name: 'Quick Breath', desc: '+3% spell haste', fx: { cast: 3 } },
      { name: 'Quick Breath', desc: '+3% spell haste', fx: { cast: 3 } },
      { name: 'Feather Step', desc: '+4% move speed', fx: { speed: 4 } },
      { name: 'Racing Pulse', desc: '+8% spell haste', fx: { cast: 8 }, kind: 'notable' },
      { name: 'Feather Step', desc: '+4% move speed', fx: { speed: 4 } },
      { name: 'Quick Breath', desc: '+4% spell haste', fx: { cast: 4 } },
      { name: 'Slipstream', desc: '+4% spell haste & move speed', fx: { cast: 4, speed: 4 } },
      { name: 'Tidal Rhythm', desc: '+9% spell haste', fx: { cast: 9 }, kind: 'notable' },
    ],
    branch: { name: 'Timeweaver', desc: '+15% spell haste', fx: { cast: 15 }, cost: 600 },
    end: { name: 'Echoing Thought', desc: '10% chance to cast every spell twice', fx: { echo: 10 }, cost: 2600 },
  },
  cosmos: {
    angle: 30,
    fx: [
      { name: 'Wider Dream', desc: '+4% area of effect', fx: { aoe: 4 } },
      { name: 'Wider Dream', desc: '+4% area of effect', fx: { aoe: 4 } },
      { name: 'Stellar Reach', desc: '+5% area of effect', fx: { aoe: 5 } },
      { name: 'Spreading Mist', desc: '+10% area of effect', fx: { aoe: 10 }, kind: 'notable' },
      { name: 'Starlight', desc: '+4% damage, +3% area', fx: { dmg: 4, aoe: 3 } },
      { name: 'Wider Dream', desc: '+5% area of effect', fx: { aoe: 5 } },
      { name: 'Event Horizon', desc: '+6% area, +4% damage', fx: { aoe: 6, dmg: 4 } },
      { name: 'Nebular Heart', desc: '+12% area of effect', fx: { aoe: 12 }, kind: 'notable' },
    ],
    branch: { name: 'Deep Field', desc: '+10% area, +6% damage', fx: { aoe: 10, dmg: 6 }, cost: 700 },
    end: { name: 'Transcendence', desc: 'All spells can grow 2 levels beyond their limit', fx: { maxLv: 2 }, cost: 4200 },
  },
  fortune: {
    angle: 90,
    fx: [
      { name: 'Dream Lure', desc: '+10% pickup radius', fx: { magnet: 10 } },
      { name: 'Dream Lure', desc: '+10% pickup radius', fx: { magnet: 10 } },
      { name: 'Gleaner', desc: '+6% essence (XP) gained', fx: { xp: 6 } },
      { name: 'Gleaner’s Eye', desc: '+10% essence gained', fx: { xp: 10 }, kind: 'notable' },
      { name: 'Stardust Eye', desc: '+8% stardust earned', fx: { dust: 8 } },
      { name: 'Stardust Eye', desc: '+8% stardust earned', fx: { dust: 8 } },
      { name: 'Gleaner', desc: '+6% essence gained', fx: { xp: 6 } },
      { name: 'Lucky Star', desc: '+12% stardust, +8% essence', fx: { dust: 12, xp: 8 }, kind: 'notable' },
    ],
    branch: { name: 'Comet’s Purse', desc: '+15% stardust earned', fx: { dust: 15 }, cost: 500 },
    end: { name: 'Twin Spark', desc: 'Begin every dream with a second random spell', fx: { twinSpark: 1 }, cost: 2000 },
  },
  vital: {
    angle: 150,
    fx: [
      { name: 'Warm Blood', desc: '+10 max life', fx: { hp: 10 } },
      { name: 'Warm Blood', desc: '+10 max life', fx: { hp: 10 } },
      { name: 'Slow Mending', desc: 'Regenerate 1 life / 2s', fx: { regen: 1 } },
      { name: 'Heartroot', desc: '+25 max life', fx: { hp: 25 }, kind: 'notable' },
      { name: 'Warm Blood', desc: '+15 max life', fx: { hp: 15 } },
      { name: 'Slow Mending', desc: 'Regenerate 1 life / 2s', fx: { regen: 1 } },
      { name: 'Deep Roots', desc: '+20 max life', fx: { hp: 20 } },
      { name: 'Heart of the Dream', desc: '+40 max life, +1 regen', fx: { hp: 40, regen: 1 }, kind: 'notable' },
    ],
    branch: { name: 'Moonmilk Vein', desc: '+2 regen, +15 max life', fx: { regen: 2, hp: 15 }, cost: 600 },
    end: { name: 'Second Wind', desc: 'Once per dream, survive death with half your life', fx: { cheatDeath: 1 }, cost: 3000 },
  },
  fate: {
    angle: -90,
    fx: [
      { name: 'Clear Sight', desc: '+3% damage, +3% area', fx: { dmg: 3, aoe: 3 } },
      { name: 'Dream Logic', desc: '+3% spell haste, +4% essence', fx: { cast: 3, xp: 4 } },
      { name: 'Clear Sight', desc: '+3% damage, +3% spell haste', fx: { dmg: 3, cast: 3 } },
      { name: 'Woven Fate', desc: '+5% damage, +5% area', fx: { dmg: 5, aoe: 5 }, kind: 'notable' },
      { name: 'Dream Logic', desc: '+4% spell haste, +4% essence', fx: { cast: 4, xp: 4 } },
      { name: 'Clear Sight', desc: '+4% damage, +3% area', fx: { dmg: 4, aoe: 3 } },
      { name: 'Threads Converge', desc: '+4% damage, +4% spell haste', fx: { dmg: 4, cast: 4 } },
      { name: 'Loom of Nights', desc: '+6% damage, +6% area', fx: { dmg: 6, aoe: 6 }, kind: 'notable' },
    ],
    branch: { name: 'Stargrave', desc: 'Slain foes burst, wounding those nearby', fx: { deathBurst: 1 }, cost: 700 },
    end: { name: 'Fourfold Path', desc: 'Level-ups offer a fourth choice', fx: { fourfold: 1 }, cost: 2400 },
  },
};

for (const [key, arm] of Object.entries(ARMS)) {
  const a = deg(arm.angle);
  let prev = 'core';
  arm.fx.forEach((n, i) => {
    const r = ARM_RADII[i];
    prev = add({
      id: `${key}${i}`, x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r),
      cost: ARM_COSTS[i], name: n.name, desc: n.desc, fx: n.fx,
      kind: n.kind || 'small', requires: [prev],
    });
  });
  // end keystone
  add({
    id: `${key}K`, x: Math.round(Math.cos(a) * 470), y: Math.round(Math.sin(a) * 470),
    cost: arm.end.cost, name: arm.end.name, desc: arm.end.desc, fx: arm.end.fx,
    kind: 'keystone', requires: [prev],
  });
  // branch keystone reached through the outer-ring small node beside it
  const ba = a + deg(30); // same bearing as the ring node: radially outward from center
  add({
    id: `${key}B`, x: Math.round(Math.cos(ba) * 400), y: Math.round(Math.sin(ba) * 400),
    cost: arm.branch.cost, name: arm.branch.name, desc: arm.branch.desc, fx: arm.branch.fx,
    kind: 'keystone', requires: [`r2-${key}`],
  });
}

// ---- connector rings: web the arms together (angular neighbours only,
// so chords never cross the center)
const ARM_KEYS = Object.keys(ARMS);
const ARM_KEYS_SORTED = [...ARM_KEYS].sort((a, b) => ARMS[a].angle - ARMS[b].angle);
const RING_FX = [
  { name: 'Faint Star', desc: '+3% spell damage', fx: { dmg: 3 } },
  { name: 'Faint Star', desc: '+2% spell haste', fx: { cast: 2 } },
  { name: 'Faint Star', desc: '+3% area of effect', fx: { aoe: 3 } },
  { name: 'Faint Star', desc: '+8 max life', fx: { hp: 8 } },
];
[{ r: 150, idx: 2, cost: 60, tag: 'r1' }, { r: 295, idx: 5, cost: 250, tag: 'r2' }].forEach((ring) => {
  ARM_KEYS_SORTED.forEach((key, k) => {
    const nextKey = ARM_KEYS_SORTED[(k + 1) % ARM_KEYS_SORTED.length];
    let a1 = ARMS[key].angle, a2 = ARMS[nextKey].angle;
    while (a2 < a1) a2 += 360;
    const mid = deg((a1 + a2) / 2);
    const f = RING_FX[(k + (ring.tag === 'r2' ? 2 : 0)) % RING_FX.length];
    add({
      id: `${ring.tag}-${key}`, x: Math.round(Math.cos(mid) * ring.r), y: Math.round(Math.sin(mid) * ring.r),
      cost: ring.cost, name: f.name, desc: f.desc, fx: f.fx,
      kind: 'small', requires: [`${key}${ring.idx}`, `${nextKey}${ring.idx}`],
    });
  });
});

// ---- satellite school clusters
const CLUSTER_DIST = 700;
const CLUSTER_R = 95;
const SCHOOL_KEYS = Object.keys(SCHOOLS);

// small-node templates per position on the ring
function schoolSmall(school, i) {
  const s = SCHOOLS[school];
  const kinds = [
    { desc: `+6% ${s.theme} damage`, fx: { school, sdmg: 6 } },
    { desc: `+4% ${s.theme} spell haste`, fx: { school, scd: 4 } },
    { desc: `+6% ${s.theme} area`, fx: { school, saoe: 6 } },
    { desc: `+6% ${s.theme} damage`, fx: { school, sdmg: 6 } },
    { desc: `+8% ${s.theme} duration`, fx: { school, sdur: 8 } },
    { desc: `+4% ${s.theme} spell haste`, fx: { school, scd: 4 } },
  ];
  // schools whose spells have no meaningful duration trade it for damage
  const noDur = ['astral', 'gale', 'dusk'].includes(school);
  const pick = kinds[i % kinds.length];
  if (noDur && pick.fx.sdur) return { desc: `+6% ${s.theme} damage`, fx: { school, sdmg: 6 } };
  return pick;
}

const CLUSTER_KEYSTONES = {
  pyre: { name: 'Rain of Cinders', desc: '+1 ember and +1 falling star', fx: { school: 'pyre', scount: 1 } },
  astral: { name: 'The Grand Orrery', desc: '+1 missile and +1 glaive', fx: { school: 'astral', scount: 1 } },
  gale: { name: 'Eye of the Tempest', desc: '+1 lightning chain, +12% frost & storm area', fx: { school: 'gale', scount: 1, saoe: 12 } },
  umbral: { name: 'Hungering Dark', desc: '+1 shadowfang, +20% rift & fang damage', fx: { school: 'umbral', scount: 1, sdmg: 20 } },
  oneiric: { name: 'Eternal Reverie', desc: '+35% cloud & rune duration, +15% damage', fx: { school: 'oneiric', sdur: 35, sdmg: 15 } },
  verdant: { name: 'Full Bloom', desc: '+1 petal and +1 lantern', fx: { school: 'verdant', scount: 1 } },
  dusk: { name: 'Total Eclipse', desc: '+1 moonlance beam, +15% lance & nova damage', fx: { school: 'dusk', scount: 1, sdmg: 15 } },
};

export const CLUSTER_INFO = []; // { school, name, color, cx, cy, ids }

SCHOOL_KEYS.forEach((school, k) => {
  const s = SCHOOLS[school];
  const ca = deg((k / SCHOOL_KEYS.length) * 360 - 90 + 26);
  const cx = Math.round(Math.cos(ca) * CLUSTER_DIST);
  const cy = Math.round(Math.sin(ca) * CLUSTER_DIST);
  const ids = [];

  // entry node on the inward side of the ring — clusters stand alone,
  // so the gate needs no connection to the central web
  const inA = Math.atan2(-cy, -cx); // toward center
  const entryId = add({
    id: `${school}-e`,
    x: Math.round(cx + Math.cos(inA) * CLUSTER_R), y: Math.round(cy + Math.sin(inA) * CLUSTER_R),
    cost: 160, name: `Gate of ${s.name}`, desc: `+5% ${s.theme} damage`, fx: { school, sdmg: 5 },
    kind: 'small', requires: [],
  });
  ids.push(entryId);

  // ring of 7 nodes (positions 1..7 around from the entry), two are notables
  const ringIds = [entryId];
  for (let i = 1; i <= 7; i++) {
    const a = inA + (i / 8) * TAU;
    const isNotable = i === 3 || i === 5;
    const tpl = isNotable
      ? (i === 3
        ? { desc: `+15% ${s.theme} damage`, fx: { school, sdmg: 15 } }
        : { desc: `+10% ${s.theme} area, +8% spell haste`, fx: { school, saoe: 10, scd: 8 } })
      : schoolSmall(school, i);
    const id = add({
      id: `${school}-r${i}`,
      x: Math.round(cx + Math.cos(a) * CLUSTER_R), y: Math.round(cy + Math.sin(a) * CLUSTER_R),
      cost: isNotable ? 550 : 140 + i * 25,
      name: isNotable ? (i === 3 ? `${s.name} Ascendant` : `${s.name} Radiant`) : `Star of ${s.name}`,
      desc: tpl.desc, fx: tpl.fx,
      kind: isNotable ? 'notable' : 'small',
      requires: [], // filled below with both ring neighbours
    });
    ringIds.push(id);
    ids.push(id);
  }
  // ring adjacency: reachable from either neighbour
  for (let i = 1; i <= 7; i++) {
    const n = nodes.find((x) => x.id === ringIds[i]);
    n.requires = [ringIds[i - 1], ringIds[(i + 1) % 8]];
  }

  // keystone in the cluster's heart, reachable from either notable
  const kDef = CLUSTER_KEYSTONES[school];
  const kId = add({
    id: `${school}-k`, x: cx, y: cy,
    cost: 2600, name: kDef.name, desc: kDef.desc, fx: kDef.fx,
    kind: 'keystone', requires: [`${school}-r3`, `${school}-r5`],
  });
  ids.push(kId);

  CLUSTER_INFO.push({ school, name: s.name, color: s.color, cx, cy, ids });
});

export const TREE_NODES = nodes;
export const NODE_MAP = Object.fromEntries(nodes.map((n) => [n.id, n]));
export const TREE_EDGES = (() => {
  const seen = new Set();
  const edges = [];
  for (const n of nodes) {
    for (const r of n.requires) {
      const key = n.id < r ? n.id + '|' + r : r + '|' + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([r, n.id]);
    }
  }
  return edges;
})();

// ---------------------------------------------------------------- storage
// legacy v1 cost table so a rework refunds everything spent
function legacyCost(id) {
  const seqA = [15, 25, 60, 90, 140, 220, 500, 900, 2600]; // might/tempo
  const seqB = { cosmos: [15, 25, 60, 90, 140, 260, 900, 4200], vital: [15, 25, 60, 90, 140, 260, 900, 3000], fortune: [15, 25, 60, 90, 140, 260, 900, 2000], fate: [30, 120, 700, 2400] };
  const m = id.match(/^([a-z]+)(\d+)$/);
  if (!m) return 0;
  const [, key, iStr] = m;
  const i = +iStr;
  if (key === 'might' || key === 'tempo') return seqA[i] || 0;
  if (seqB[key]) return seqB[key][i] || 0;
  return 0;
}

export function loadMeta() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { dust: d.dust || 0, owned: Array.isArray(d.owned) ? d.owned : ['core'], best: d.best || 0 };
    }
    // migrate v1: full respec, refund everything spent
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      const d = JSON.parse(old);
      const refund = (d.owned || []).reduce((s, id) => s + legacyCost(id), 0);
      const meta = { dust: (d.dust || 0) + refund, owned: ['core'], best: d.best || 0 };
      saveMeta(meta);
      return meta;
    }
  } catch (e) { /* corrupted store — start fresh */ }
  return { dust: 0, owned: ['core'], best: 0 };
}

export function saveMeta(meta) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(meta)); } catch (e) { /* private mode */ }
}

// undirected adjacency: owning either endpoint of an edge opens the other
export const ADJACENT = (() => {
  const adj = {};
  for (const [a, b] of TREE_EDGES) {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  }
  return adj;
})();

export function isReachable(meta, id) {
  const n = NODE_MAP[id];
  if (!n) return false;
  if (n.requires.length === 0) return true; // core & standalone cluster gates
  return (ADJACENT[id] || []).some((r) => meta.owned.includes(r));
}

export function canBuy(meta, id) {
  const n = NODE_MAP[id];
  if (!n || meta.owned.includes(id) || meta.dust < n.cost) return false;
  return isReachable(meta, id);
}

export function buyNode(meta, id) {
  if (!canBuy(meta, id)) return meta;
  const next = { ...meta, dust: meta.dust - NODE_MAP[id].cost, owned: [...meta.owned, id] };
  saveMeta(next);
  return next;
}

// fold owned nodes into one bonus object for the engine.
// spellMods: per-spell-id { dmg, cd, aoe, dur, count } from school clusters.
export function computeBonuses(meta) {
  const b = {
    dmg: 0, cast: 0, aoe: 0, speed: 0, magnet: 0, xp: 0, dust: 0, crit: 0, critDmg: 0,
    hp: 0, regen: 0, extraCount: 0, echo: 0, maxLv: 0, twinSpark: 0, fourfold: 0,
    cheatDeath: 0, deathBurst: 0, spellMods: {},
  };
  const modFor = (spell) => (b.spellMods[spell] = b.spellMods[spell] || { dmg: 0, cd: 0, aoe: 0, dur: 0, count: 0 });
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (!n) continue;
    for (const [k, v] of Object.entries(n.fx)) {
      if (k === 'school') continue;
      if (k.startsWith('s') && ['sdmg', 'scd', 'saoe', 'sdur', 'scount'].includes(k)) {
        for (const spell of SCHOOLS[n.fx.school].spells) {
          const m = modFor(spell);
          if (k === 'sdmg') m.dmg += v;
          if (k === 'scd') m.cd += v;
          if (k === 'saoe') m.aoe += v;
          if (k === 'sdur') m.dur += v;
          if (k === 'scount') m.count += v;
        }
      } else {
        b[k] = (b[k] || 0) + v;
      }
    }
  }
  return b;
}

export function dustForRun(result, bonuses) {
  const base = result.kills * 0.35 + result.level * 3 + result.time / 6;
  // bonusDust (golden wisps, fallen stars) is flat, on top of the multiplier
  return Math.max(1, Math.round(base * (1 + (bonuses.dust || 0) / 100)) + (result.bonusDust || 0));
}

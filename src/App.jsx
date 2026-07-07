import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Engine } from './game/engine.js';
import { SPELLS, BOONS, GENERIC, EVOLVE } from './game/spells.js';
import { audio } from './game/audio.js';
import { TREE_NODES, TREE_EDGES, NODE_MAP, CLUSTER_INFO, loadMeta, saveMeta, canBuy, buyNode, canRefund, refundNode, refundValue, isReachable, computeBonuses, dustForRun } from './game/meta.js';

const useGame = create((set) => ({
  screen: 'menu', // menu | playing | levelup | dead | tree
  hud: null,
  choices: [],
  newLevel: 1,
  banishes: 0,
  rerolls: 0,
  result: null,
  dustEarned: 0,
  meta: loadMeta(),
  muted: false,
  set,
}));

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const { screen, hud, choices, newLevel, banishes, rerolls, result, dustEarned, meta, muted, set } = useGame();

  useEffect(() => {
    const engine = new Engine(canvasRef.current, {
      onHud: (h) => set({ hud: h }),
      onLevelUp: (ch, lvl, banishes, rerolls) => set({ screen: 'levelup', choices: ch, newLevel: lvl, banishes, rerolls }),
      onGameOver: (r) => {
        const st = useGame.getState();
        const bonuses = computeBonuses(st.meta);
        const earned = dustForRun(r, bonuses);
        const next = {
          ...st.meta,
          dust: st.meta.dust + earned,
          shards: (st.meta.shards || 0) + (r.shards || 0),
          best: Math.max(st.meta.best || 0, Math.floor(r.time)),
        };
        saveMeta(next);
        set({ screen: 'dead', result: r, dustEarned: earned, meta: next });
      },
      getMeta: () => computeBonuses(useGame.getState().meta),
    });
    engineRef.current = engine;
    engine.paused = true;
    engine.start();
    return () => engine.stop();
  }, [set]);

  const begin = () => {
    audio.resume();
    engineRef.current.reset();
    engineRef.current.paused = false;
    engineRef.current.pushHud(true);
    set({ screen: 'playing', result: null });
  };

  const pickChoice = (c) => {
    // chooseUpgrade returns true when another queued level-up was dealt in its
    // place (it fires onLevelUp itself); only fall back to play when the hand
    // is truly empty, or we'd hide the next choice.
    const more = engineRef.current.chooseUpgrade(c);
    if (!more) set({ screen: 'playing' });
  };

  const toggleMute = () => {
    const m = !muted;
    audio.setEnabled(!m);
    set({ muted: m });
  };

  // transition between full-screen overlays (menu ↔ tree ↔ dead): the old
  // screen stays fully opaque underneath while the new one fades in on top,
  // so the combined cover never dips below 1 (no mid-fade "blink").
  // useLayoutEffect (not useEffect) so the leaving screen is re-attached in
  // the same paint as the screen switch — an effect would run *after* paint,
  // flashing one frame with the old overlay gone and the new one transparent.
  const [leaving, setLeaving] = useState(null);
  const prevScreenRef = useRef(screen);
  useLayoutEffect(() => {
    const from = prevScreenRef.current;
    prevScreenRef.current = screen;
    const fadeable = ['menu', 'tree', 'dead'];
    if (from !== screen && fadeable.includes(from) && fadeable.includes(screen)) {
      setLeaving(from);
      const t = setTimeout(() => setLeaving(null), 720);
      return () => clearTimeout(t);
    }
  }, [screen]);

  // stable keys (no isLeaving suffix): when a screen flips from current to
  // leaving, React moves the same element instead of remounting it, so its
  // DOM (and the tree's pan/zoom) survives the fade untouched
  const renderOverlay = (s, isLeaving) => {
    if (s === 'menu') return <Menu key="menu" leaving={isLeaving} onStart={begin} meta={meta} onTree={() => set({ screen: 'tree' })} />;
    if (s === 'dead' && result) return <GameOver key="dead" leaving={isLeaving} result={result} dustEarned={dustEarned} onRetry={begin} onTree={() => set({ screen: 'tree' })} />;
    if (s === 'tree') return (
      <SkillTree
        key="tree"
        leaving={isLeaving}
        meta={meta}
        onBuy={(id) => set({ meta: buyNode(useGame.getState().meta, id) })}
        onRefund={(id) => set({ meta: refundNode(useGame.getState().meta, id) })}
        onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })}
      />
    );
    return null;
  };

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="game-canvas" />

      {screen === 'playing' && hud && <Hud hud={hud} muted={muted} onMute={toggleMute} />}
      {screen === 'playing' && hud && hud.paused && <div className="pause-overlay">PAUSED</div>}

      {screen === 'levelup' && (
        <LevelUp
          choices={choices}
          level={newLevel}
          banishes={banishes}
          rerolls={rerolls}
          showBanish={computeBonuses(meta).banish > 0}
          showReroll={computeBonuses(meta).reroll > 0}
          onPick={pickChoice}
          onBanish={(c) => engineRef.current.banish(c)}
          onReroll={() => engineRef.current.reroll()}
        />
      )}
      {[
        renderOverlay(screen, false),
        leaving && leaving !== screen ? renderOverlay(leaving, true) : null,
      ]}
    </div>
  );
}

function Hud({ hud, muted, onMute }) {
  return (
    <>
      <div className="hud-top">
        <div className="bar-wrap">
          <div className="bar hp">
            <div className="fill" style={{ width: `${(100 * hud.hp) / hud.maxHp}%` }} />
            <span>{Math.ceil(hud.hp)} / {hud.maxHp}</span>
          </div>
          <div className="bar xp">
            <div className="fill" style={{ width: `${(100 * hud.xp) / hud.xpNext}%` }} />
            <span>Reverie {hud.level}</span>
          </div>
        </div>
        <div className="hud-center">
          <div className="clock">{fmtTime(hud.time)}</div>
          <div className="kills">{hud.kills} banished</div>
          <div className="dust-live">✦ {hud.dust}</div>
          {hud.shards > 0 && <div className="dust-live shards">❖ {hud.shards}</div>}
        </div>
        <button className="mute" onClick={onMute}>{muted ? '🔇' : '🔊'}</button>
      </div>
      <div className="hud-spells">
        {hud.spells.map((s) => (
          <div key={s.id} className={`spell-chip ${s.evolved ? 'evolved' : ''}`} style={{ '--c': SPELLS[s.id].color }}>
            <span className="glyph">{SPELLS[s.id].icon}</span>
            <span className="lv">{s.evolved ? '★' : s.level}</span>
          </div>
        ))}
        {Array.from({ length: Math.max(0, (hud.spellCap || 6) - hud.spells.length) }).map((_, i) => (
          <div key={`empty-${i}`} className="spell-chip empty" title="Empty spell slot">
            <span className="glyph">+</span>
          </div>
        ))}
        {Object.entries(hud.boons).map(([id, lv]) => (
          <div key={id} className="spell-chip boon">
            <span className="glyph">{BOONS[id].icon}</span>
            <span className="lv">{lv}</span>
          </div>
        ))}
      </div>
      <div className="hint">WASD / arrows to drift — your spells cast themselves</div>
    </>
  );
}

function Menu({ onStart, onTree, meta, leaving }) {
  return (
    <div className={`overlay menu ${leaving ? 'leaving' : ''}`}>
      <div className="title-block">
        <div className="eyebrow">A reverie survival</div>
        <h1>DREAMTIDE</h1>
        <p className="sub">
          You are the last magus awake inside a drowning dream. The tide brings
          wisps, shades and worse. Drift, survive, and let fourteen schools of
          magic bloom around you.
        </p>
        <div className="menu-buttons">
          <button className="btn-primary" onClick={onStart}>Fall asleep</button>
          <button className="btn-secondary" onClick={onTree}>
            ✦ Constellation
            <span className="dust-chip">✦ {meta.dust}{(meta.shards || 0) > 0 ? ` · ❖ ${meta.shards}` : ''}</span>
          </button>
        </div>
        <div className="controls-hint">Move with WASD or arrow keys · spells are cast automatically · choose wisely when you level</div>
      </div>
    </div>
  );
}

function LevelUp({ choices, level, banishes, rerolls, showBanish, showReroll, onPick, onBanish, onReroll }) {
  const [banishing, setBanishing] = useState(null); // index of the dissolving card
  const [rolling, setRolling] = useState(false);
  const [deal, setDeal] = useState(0); // bumps to remount the hand after a reroll
  const busy = banishing != null || rolling;
  // one pick per hand: picking a card can immediately deal the next queued
  // level-up (same component, new choices). A stray double-click in that window
  // would otherwise apply two upgrades + play two sounds — so lock until the
  // hand actually changes. The ref resets whenever a new hand arrives.
  const picked = useRef(false);
  const handSig = `${level}:${choices.map((c) => `${c.kind}:${c.id}`).join(',')}`;
  const lastSig = useRef(handSig);
  if (handSig !== lastSig.current) { lastSig.current = handSig; picked.current = false; }
  const pick = (c) => {
    if (picked.current || busy) return;
    picked.current = true;
    onPick(c);
  };
  const doBanish = (c, i) => {
    if (busy) return;
    setBanishing(i);
    // let the card dissolve into mist before the replacement is dealt
    setTimeout(() => { onBanish(c); setBanishing(null); }, 480);
  };
  const doReroll = () => {
    if (busy || rerolls <= 0) return;
    setRolling(true);
    // the whole hand scatters into stardust, then a fresh one is dealt
    setTimeout(() => { onReroll(); setDeal((d) => d + 1); setRolling(false); }, 420);
  };
  return (
    <div className="overlay levelup">
      <div className="eyebrow">Reverie deepens</div>
      <h2>Level {level}</h2>
      <div className={`cards ${rolling ? 'rolling' : ''}`} key={deal}>
        {choices.map((c, i) => {
          const isEvolve = c.kind === 'evolve';
          const isSpell = c.kind === 'spell' || isEvolve;
          const def = isSpell ? SPELLS[c.id] : c.kind === 'boon' ? BOONS[c.id] : GENERIC[c.id];
          return (
            <div key={`${c.kind}-${c.id}-${i}`} className={`card-slot ${banishing === i ? 'banishing' : ''}`}>
              <button
                className={`card ${isEvolve ? 'evolve' : isSpell ? 'spell' : 'boon'}`}
                style={isSpell ? { '--c': def.color, '--c2': def.color2 } : { '--c': '#ffd27a', '--c2': '#fff2cc' }}
                onClick={() => pick(c)}
              >
                <div className="card-glyph">{def.icon}</div>
                <div className="card-name">{isEvolve ? EVOLVE[c.id].name : def.name}</div>
                <div className="card-school">
                  {isEvolve ? `${def.school} · Evolution` : isSpell ? `${def.school} · ${c.isNew ? 'New spell' : c.mastery ? `Mastery ${c.level}` : `Level ${c.level}`}` : `${c.kind === 'generic' ? 'Amplify' : 'Boon'} · Rank ${c.level}`}
                </div>
                <div className="card-desc">
                  {isEvolve ? EVOLVE[c.id].desc : c.kind === 'generic' ? def.desc : (isSpell ? (c.isNew ? def.desc : c.mastery ? 'Pure damage — the dream deepens beyond its limits.' : def.levelText(c.level)) : def.desc)}
                </div>
              </button>
              {showBanish && (
                <button
                  className="banish-btn"
                  disabled={banishes <= 0 || banishing != null}
                  title="Banish: never see this again this dream"
                  onClick={() => doBanish(c, i)}
                >
                  ✕ banish
                </button>
              )}
            </div>
          );
        })}
      </div>
      {(showBanish || showReroll) && (
        <div className="levelup-tools">
          {showReroll && (
            <button
              className="reroll-btn"
              disabled={rerolls <= 0 || busy}
              title="Reroll: scatter these choices and dream up new ones"
              onClick={doReroll}
            >
              ⟳ reroll the dream
            </button>
          )}
          <div className="banish-count">
            {[
              showBanish ? `${banishes} banish${banishes === 1 ? '' : 'es'}` : null,
              showReroll ? `${rerolls} reroll${rerolls === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' · ')} left this dream
          </div>
        </div>
      )}
    </div>
  );
}

function GameOver({ result, dustEarned, onRetry, onTree, leaving }) {
  return (
    <div className={`overlay dead ${leaving ? 'leaving' : ''}`}>
      <div className="eyebrow">The dream closes over you</div>
      <h2>You wake</h2>
      <div className="result-row">
        <div><span className="num">{fmtTime(result.time)}</span><span className="lbl">survived</span></div>
        <div><span className="num">{result.kills}</span><span className="lbl">banished</span></div>
        <div><span className="num">{result.level}</span><span className="lbl">reverie</span></div>
        <div><span className="num dust">+{dustEarned}</span><span className="lbl">stardust</span></div>
        {(result.shards || 0) > 0 && <div><span className="num shards">+{result.shards}</span><span className="lbl">shards</span></div>}
      </div>
      <div className="menu-buttons">
        <button className="btn-primary" onClick={onRetry}>Sleep again</button>
        <button className="btn-secondary" onClick={onTree}>✦ Constellation</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- skill tree
const KIND_R = { core: 16, small: 9, notable: 13, keystone: 17 };
const KIND_ICON_SIZE = { core: 15, small: 9.5, notable: 13, keystone: 15 };

// a glyph per node so the tree can be read at a glance
function nodeIcon(n) {
  const fx = n.fx || {};
  if (n.kind === 'core') return '☉';
  if (n.currency === 'shards') return '❖'; // the Dark Bargain's own mark
  if (fx.spell) {
    if (fx.evo) return '★';
    if (fx.sdmg) return '✦';
    if (fx.scd) return '≋';
    if (fx.saoe) return '◎';
    if (fx.sdur) return '◷';
    return SPELLS[fx.spell].icon; // entry, start & spell-specific mediums
  }
  const ICONS = [
    ['banish', '✕'], ['reroll', '⟳'], ['fourfold', '✥'],
    ['spellSlots', '▣'], ['extraCount', '✚'], ['echo', '⧉'], ['masteryPlus', '⇑'], ['startLv', '✬'],
    ['cheatDeath', '♥'], ['deathBurst', '✺'],
    ['gemMerge', '⬢'], ['golden', '✯'], ['extraGem', '❂'],
    ['surgeAll', '∿'], ['surgeDur', '∿'], ['surgeSpeed', '➳'], ['surgeDmg', '✦'],
    ['surgeHaste', '≋'], ['surgeAoe', '◎'], ['surgeMagnet', '◉'],
    ['crit', '✸'], ['critDmg', '✸'],
    ['dmg', '✦'], ['cast', '≋'], ['aoe', '◎'], ['speed', '➳'],
    ['hp', '❤'], ['regen', '☽'], ['magnet', '◉'], ['xp', '❂'], ['dust', '✧'],
  ];
  for (const [k, ic] of ICONS) if (fx[k]) return ic;
  return '';
}

const TREE_VIEW = 2480; // viewBox span

// Static edge geometry — the tree never moves, so compute each edge's shape and
// endpoints once at module load rather than on every render/pan.
const EDGE_GEOM = TREE_EDGES.map(([a, b, bend]) => {
  const na = NODE_MAP[a], nb = NODE_MAP[b];
  if (!na || !nb) return null;
  const dark = a.startsWith('dark-') && b.startsWith('dark-');
  let d = null, line = null;
  if (!bend) {
    line = { x1: na.x, y1: na.y, x2: nb.x, y2: nb.y };
  } else {
    const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx + (-dy / len) * bend, cy = my + (dx / len) * bend;
    d = `M ${na.x} ${na.y} Q ${cx} ${cy} ${nb.x} ${nb.y}`;
  }
  return { a, b, dark, d, line };
}).filter(Boolean);

// Edge layer, memoized so it only re-renders when ownership changes (not on
// pan, zoom, or tooltip hover).
const TreeEdges = React.memo(function TreeEdges({ owned }) {
  return EDGE_GEOM.map((e, i) => {
    const lit = owned.has(e.a) && owned.has(e.b);
    const half = !lit && (owned.has(e.a) || owned.has(e.b));
    const cls = `tree-edge ${e.dark ? 'dark ' : ''}${lit ? 'lit' : half ? 'half' : ''}`;
    return e.line
      ? <line key={i} x1={e.line.x1} y1={e.line.y1} x2={e.line.x2} y2={e.line.y2} className={cls} />
      : <path key={i} d={e.d} className={cls} />;
  });
});

function SkillTree({ meta, onBuy, onRefund, onClose, leaving }) {
  const [tip, setTip] = useState(null); // { id, x, y } in viewport coords
  // `view` is the committed pan/zoom; while dragging we bypass React entirely
  // and mutate the group transform imperatively, so the ~1500 SVG elements
  // never re-render mid-drag. viewRef mirrors the live value between commits.
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  const gRef = useRef(null);
  const dragRef = useRef(null);
  // rebuild the owned-set only when the owned list actually changes
  const owned = useMemo(() => new Set(meta.owned), [meta.owned]);
  const node = tip ? NODE_MAP[tip.id] : null;

  const applyTransform = (v) => {
    if (gRef.current) gRef.current.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`);
  };

  const hover = (n) => (e) => {
    if (dragRef.current && dragRef.current.moved) return; // don't pop tips mid-pan
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ id: n.id, x: r.left + r.width / 2, y: r.top });
  };

  const onWheel = (e) => {
    const v = viewRef.current;
    const z = Math.min(3.2, Math.max(0.55, v.z * (e.deltaY < 0 ? 1.15 : 0.87)));
    const next = { ...v, z };
    viewRef.current = next;
    applyTransform(next);
    setView(next);
  };
  const onMouseDown = (e) => {
    const v = viewRef.current;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
  };
  const onMouseMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) { if (!d.moved) setTip(null); d.moved = true; }
    if (!d.moved) return;
    const k = TREE_VIEW / e.currentTarget.clientWidth;
    // pan imperatively — no setState, no re-render of the tree
    const next = { x: d.ox + dx * k, y: d.oy + dy * k, z: viewRef.current.z };
    viewRef.current = next;
    applyTransform(next);
  };
  const endDrag = () => {
    const d = dragRef.current;
    // commit the imperative pan back into React state, once
    if (d && d.moved) setView(viewRef.current);
    setTimeout(() => { dragRef.current = null; }, 0);
  };
  const wasDrag = () => dragRef.current && dragRef.current.moved;

  return (
    <div className={`overlay tree-overlay ${leaving ? 'leaving' : ''}`}>
      <div className="tree-bg" aria-hidden="true" />
      <div className="tree-head">
        <div>
          <div className="eyebrow">The Constellation</div>
          <div className="tree-sub">Drag to pan, scroll to zoom. Hover a star to read it; click to awaken it — or click an awakened star to release it for half its stardust.</div>
        </div>
        <div className="tree-progress">{meta.owned.length - 1}/{TREE_NODES.length - 1}</div>
        <div className="dust-big">✦ {meta.dust}</div>
        <div className="dust-big shards" title="Nightmare shards — torn from slain bosses, they feed the Dark Bargain">❖ {meta.shards || 0}</div>
        <button className="btn-secondary" onClick={onClose}>Return</button>
      </div>

      <div className="tree-scroll">
        <svg
          viewBox={`${-TREE_VIEW / 2} ${-TREE_VIEW / 2} ${TREE_VIEW} ${TREE_VIEW}`}
          className="tree-svg"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
        >
          <g ref={gRef} transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
          {/* edges — geometry is precomputed; only the lit/half class depends on
              ownership, so this whole layer is memoized against the owned set */}
          <TreeEdges owned={owned} />
          {/* nodes */}
          {TREE_NODES.map((n) => {
            const isOwned = owned.has(n.id);
            const buyable = canBuy(meta, n.id);
            const reach = isReachable(meta, n.id);
            const refundable = isOwned && canRefund(meta, n.id);
            const r = KIND_R[n.kind] || 9;
            return (
              <g
                key={n.id}
                className={`tree-node ${n.kind} ${n.currency === 'shards' ? 'dark' : ''} ${isOwned ? 'owned' : buyable ? 'buyable' : reach ? 'reach' : 'locked'} ${refundable ? 'refundable' : ''}`}
                transform={`translate(${n.x},${n.y})`}
                onMouseEnter={hover(n)}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  if (wasDrag()) return;
                  if (buyable) { onBuy(n.id); audio.choose(); }
                  else if (refundable) { onRefund(n.id); audio.voidCast(); }
                }}
              >
                <circle className="halo" r={r + 7} />
                <circle className="body" r={r} />
                {n.kind === 'keystone' && <circle className="inner" r={r * 0.72} />}
                <text className="node-icon" fontSize={KIND_ICON_SIZE[n.kind] || 9.5}>{nodeIcon(n)}</text>
              </g>
            );
          })}
          {/* cluster labels with owned counts */}
          {CLUSTER_INFO.map((c) => {
            const got = c.ids.filter((id) => owned.has(id)).length;
            return (
              <g key={c.spell} className="cluster-label" transform={`translate(${c.cx},${c.cy + 158})`}>
                <text className="cluster-name" style={{ fill: c.color }}>{c.name}</text>
                <text className="cluster-count" y="24">{got}/{c.ids.length}</text>
              </g>
            );
          })}
          </g>
        </svg>

        {node && (
          <div className="node-tip" style={{ left: tip.x, top: tip.y }}>
            <div className="tip-name">
              {node.name}
              <span className={`tip-kind ${node.kind}`}>{node.kind === 'core' ? 'origin' : node.kind}</span>
            </div>
            <div className="tip-desc">{node.desc}</div>
            {owned.has(node.id) ? (
              <div className="tip-owned">
                ✓ awakened
                {node.id !== 'core' && (
                  canRefund(meta, node.id)
                    ? <span className="tip-refund"> · click to release for {node.currency === 'shards' ? '❖' : '✦'} {refundValue(node.id)}</span>
                    : <span className="tip-locked"> · other stars depend on this one</span>
                )}
              </div>
            ) : (
              <div className="tip-row">
                <span className={`tip-cost ${node.currency === 'shards' ? 'shards' : ''}`}>{node.currency === 'shards' ? '❖' : '✦'} {node.cost}</span>
                {canBuy(meta, node.id) ? (
                  <span className="tip-hint">click to awaken</span>
                ) : (
                  <span className="tip-locked">
                    {isReachable(meta, node.id)
                      ? (node.currency === 'shards' ? 'not enough nightmare shards — bosses drop them' : 'not enough stardust')
                      : 'connect the path first'}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

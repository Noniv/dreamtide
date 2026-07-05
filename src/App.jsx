import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Engine } from './game/engine.js';
import { SPELLS, BOONS, GENERIC } from './game/spells.js';
import { audio } from './game/audio.js';
import { TREE_NODES, TREE_EDGES, NODE_MAP, CLUSTER_INFO, loadMeta, saveMeta, canBuy, buyNode, isReachable, computeBonuses, dustForRun } from './game/meta.js';

const useGame = create((set) => ({
  screen: 'menu', // menu | playing | levelup | dead | tree
  hud: null,
  choices: [],
  newLevel: 1,
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
  const { screen, hud, choices, newLevel, result, dustEarned, meta, muted, set } = useGame();

  useEffect(() => {
    const engine = new Engine(canvasRef.current, {
      onHud: (h) => set({ hud: h }),
      onLevelUp: (ch, lvl) => set({ screen: 'levelup', choices: ch, newLevel: lvl }),
      onGameOver: (r) => {
        const st = useGame.getState();
        const bonuses = computeBonuses(st.meta);
        const earned = dustForRun(r, bonuses);
        const next = {
          ...st.meta,
          dust: st.meta.dust + earned,
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
    engineRef.current.chooseUpgrade(c);
    set({ screen: 'playing' });
  };

  const toggleMute = () => {
    const m = !muted;
    audio.setEnabled(!m);
    set({ muted: m });
  };

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="game-canvas" />

      {screen === 'playing' && hud && <Hud hud={hud} muted={muted} onMute={toggleMute} />}
      {screen === 'playing' && hud && hud.paused && <div className="pause-overlay">PAUSED</div>}

      {screen === 'menu' && <Menu onStart={begin} meta={meta} onTree={() => set({ screen: 'tree' })} />}
      {screen === 'levelup' && <LevelUp choices={choices} level={newLevel} onPick={pickChoice} />}
      {screen === 'dead' && result && (
        <GameOver result={result} dustEarned={dustEarned} onRetry={begin} onTree={() => set({ screen: 'tree' })} />
      )}
      {screen === 'tree' && (
        <SkillTree
          meta={meta}
          onBuy={(id) => set({ meta: buyNode(useGame.getState().meta, id) })}
          onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })}
        />
      )}
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
        </div>
        <button className="mute" onClick={onMute}>{muted ? '🔇' : '🔊'}</button>
      </div>
      <div className="hud-spells">
        {hud.spells.map((s) => (
          <div key={s.id} className="spell-chip" style={{ '--c': SPELLS[s.id].color }}>
            <span className="glyph">{SPELLS[s.id].icon}</span>
            <span className="lv">{s.level}</span>
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

function Menu({ onStart, onTree, meta }) {
  return (
    <div className="overlay menu">
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
            <span className="dust-chip">{meta.dust} stardust</span>
          </button>
        </div>
        <div className="controls-hint">Move with WASD or arrow keys · spells are cast automatically · choose wisely when you level</div>
      </div>
    </div>
  );
}

function LevelUp({ choices, level, onPick }) {
  return (
    <div className="overlay levelup">
      <div className="eyebrow">Reverie deepens</div>
      <h2>Level {level}</h2>
      <div className="cards">
        {choices.map((c, i) => {
          const def = c.kind === 'spell' ? SPELLS[c.id] : c.kind === 'boon' ? BOONS[c.id] : GENERIC[c.id];
          const isSpell = c.kind === 'spell';
          return (
            <button
              key={i}
              className={`card ${isSpell ? 'spell' : 'boon'}`}
              style={isSpell ? { '--c': def.color, '--c2': def.color2 } : { '--c': '#ffd27a', '--c2': '#fff2cc' }}
              onClick={() => onPick(c)}
            >
              <div className="card-glyph">{def.icon}</div>
              <div className="card-name">{def.name}</div>
              <div className="card-school">
                {isSpell ? def.school : 'Boon'} · {c.kind === 'generic' ? `Rank ${c.level}` : (isSpell ? (c.isNew ? 'New spell' : `Level ${c.level}`) : `Rank ${c.level}`)}
              </div>
              <div className="card-desc">
                {c.kind === 'generic' ? def.desc : (isSpell ? (c.isNew ? def.desc : def.levelText(c.level)) : def.desc)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GameOver({ result, dustEarned, onRetry, onTree }) {
  return (
    <div className="overlay dead">
      <div className="eyebrow">The dream closes over you</div>
      <h2>You wake</h2>
      <div className="result-row">
        <div><span className="num">{fmtTime(result.time)}</span><span className="lbl">survived</span></div>
        <div><span className="num">{result.kills}</span><span className="lbl">banished</span></div>
        <div><span className="num">{result.level}</span><span className="lbl">reverie</span></div>
        <div><span className="num dust">+{dustEarned}</span><span className="lbl">stardust</span></div>
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

const TREE_VIEW = 1780; // viewBox span

function SkillTree({ meta, onBuy, onClose }) {
  const [tip, setTip] = useState(null); // { id, x, y } in viewport coords
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const dragRef = useRef(null);
  const owned = new Set(meta.owned);
  const node = tip ? NODE_MAP[tip.id] : null;

  const hover = (n) => (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ id: n.id, x: r.left + r.width / 2, y: r.top });
  };

  const onWheel = (e) => {
    const z = Math.min(3.2, Math.max(0.55, view.z * (e.deltaY < 0 ? 1.15 : 0.87)));
    setView((v) => ({ ...v, z }));
  };
  const onMouseDown = (e) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  };
  const onMouseMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
    if (!d.moved) return;
    const k = TREE_VIEW / e.currentTarget.clientWidth;
    setView((v) => ({ ...v, x: d.ox + dx * k, y: d.oy + dy * k }));
  };
  const endDrag = () => { setTimeout(() => { dragRef.current = null; }, 0); };
  const wasDrag = () => dragRef.current && dragRef.current.moved;

  return (
    <div className="overlay tree-overlay">
      <div className="tree-head">
        <div>
          <div className="eyebrow">The Constellation</div>
          <div className="tree-sub">Drag to pan, scroll to zoom. Hover a star to read it; click to awaken it.</div>
        </div>
        <div className="tree-progress">{meta.owned.length - 1}/{TREE_NODES.length - 1}</div>
        <div className="dust-big">✦ {meta.dust}</div>
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
          <g transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
          {/* edges */}
          {TREE_EDGES.map(([a, b], i) => {
            const na = NODE_MAP[a], nb = NODE_MAP[b];
            if (!na || !nb) return null;
            const lit = owned.has(a) && owned.has(b);
            const half = owned.has(a) || owned.has(b);
            return (
              <line
                key={i}
                x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                className={`tree-edge ${lit ? 'lit' : half ? 'half' : ''}`}
              />
            );
          })}
          {/* nodes */}
          {TREE_NODES.map((n) => {
            const isOwned = owned.has(n.id);
            const buyable = canBuy(meta, n.id);
            const reach = isReachable(meta, n.id);
            const r = KIND_R[n.kind] || 9;
            return (
              <g
                key={n.id}
                className={`tree-node ${n.kind} ${isOwned ? 'owned' : buyable ? 'buyable' : reach ? 'reach' : 'locked'}`}
                transform={`translate(${n.x},${n.y})`}
                onMouseEnter={hover(n)}
                onMouseLeave={() => setTip(null)}
                onClick={() => { if (buyable && !wasDrag()) { onBuy(n.id); audio.choose(); } }}
              >
                <circle className="halo" r={r + 7} />
                <circle className="body" r={r} />
                {n.kind === 'keystone' && <circle className="inner" r={r * 0.45} />}
              </g>
            );
          })}
          {/* cluster labels with owned counts */}
          {CLUSTER_INFO.map((c) => {
            const got = c.ids.filter((id) => owned.has(id)).length;
            return (
              <g key={c.school} className="cluster-label" transform={`translate(${c.cx},${c.cy + 140})`}>
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
              <div className="tip-owned">✓ awakened</div>
            ) : (
              <div className="tip-row">
                <span className="tip-cost">✦ {node.cost}</span>
                {canBuy(meta, node.id) ? (
                  <span className="tip-hint">click to awaken</span>
                ) : (
                  <span className="tip-locked">
                    {isReachable(meta, node.id) ? 'not enough stardust' : 'connect the path first'}
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

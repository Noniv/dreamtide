// Dev profiler — toggled with F. Its job is to CATCH STUTTERS, not to log every
// frame. It keeps lightweight rolling stats over the whole session but only
// records *full detail* for the worst frames, then exports a focused report.
//
// Each captured spike answers "why was this frame slow?" by including:
//   - frameMs        : CPU work this frame (update + render), performance.now based
//   - intervalMs     : true frame-to-frame interval (tracks real refresh / vsync)
//   - sections       : per-block CPU cost (update, enemies, projectiles, …)
//   - gapMs          : frameMs minus the summed sections. A large gap means the
//                      time was spent OUTSIDE our measured code — the signature of
//                      a GC pause or a browser/compositor hitch, not game logic.
//   - longTaskMs     : duration of any Long Task the browser reported near this
//                      frame (PerformanceObserver) — direct GC/main-thread stall.
//   - heapMB / heapDeltaMB : JS heap size and its change vs the previous frame. A
//                      sharp drop == a garbage collection just happened.
//   - spawned        : how many enemies/projectiles/zones/particles appeared this
//                      frame (count deltas) — correlates spikes with spawn bursts.
//
// zero-overhead when idle: every hot-path probe early-returns on `!recording`.

const KEEP_WORST = 40;   // how many worst frames to retain in full detail
const KEEP_LONGTASKS = 60;

export class Profiler {
  constructor() {
    this.recording = false;
    this._startedAt = 0;

    // rolling whole-session stats (cheap, no per-frame allocation)
    this._n = 0;
    this._sumFrameMs = 0;
    this._minFrameMs = Infinity;
    this._maxFrameMs = 0;
    this._sumSections = {};      // name -> total ms (for the average breakdown)
    this._peakCounts = {};
    this._histFrameMs = [];      // coarse histogram buckets (see _bucket)
    this._worst = [];            // min-heap-ish array of the worst frames (kept sorted asc by frameMs)

    // in-progress frame
    this._frameStart = 0;
    this._lastMark = 0;
    this._pending = null;
    this._sections = null;
    this._counts = null;
    this._prevNow = 0;           // for true interval
    this._prevHeap = 0;          // for heap delta / GC detection
    this._prevSpawnBase = null;  // counts at end of last frame, for spawn deltas

    // long-task capture (GC / main-thread stalls)
    this._longtasks = [];        // recent {t, dur}
    this._lto = null;
    this._initLongTasks();
  }

  _initLongTasks() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this._lto = new PerformanceObserver((list) => {
        if (!this.recording) return;
        for (const e of list.getEntries()) {
          this._longtasks.push({ t: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) });
          if (this._longtasks.length > KEEP_LONGTASKS) this._longtasks.shift();
        }
      });
      // buffered:true grabs long tasks that fired just before we subscribed
      this._lto.observe({ type: 'longtask', buffered: true });
    } catch { this._lto = null; }
  }

  toggle() {
    if (this.recording) this._stopAndExport();
    else this._start();
    return this.recording;
  }

  _start() {
    this.recording = true;
    this._startedAt = Date.now();
    this._n = 0; this._sumFrameMs = 0; this._minFrameMs = Infinity; this._maxFrameMs = 0;
    this._sumSections = {}; this._peakCounts = {}; this._histFrameMs = [];
    this._worst = [];
    this._longtasks = [];
    this._prevNow = 0; this._prevHeap = 0; this._prevSpawnBase = null;
  }

  // ---- called from the game loop, once per frame ----------------------------

  // top of loop, before update(). `counts` snapshots live entity counts BEFORE
  // this frame's spawns so we can compute per-frame spawn deltas.
  frameBegin(now, spawnBase) {
    if (!this.recording) return;
    this._frameStart = now;
    this._lastMark = now;
    this._pending = null;
    this._sections = {};
    this._counts = null;
    this._spawnBase = spawnBase; // {enemies, projectiles, zones, particles} at frame start
  }

  mark(name) {
    if (!this.recording) return;
    const t = performance.now();
    if (this._pending) this._sections[this._pending] = (this._sections[this._pending] || 0) + (t - this._lastMark);
    this._pending = name;
    this._lastMark = t;
  }

  counts(c) {
    if (!this.recording) return;
    this._counts = c;
  }

  // end of loop, after render()
  frameEnd(now, spawnEnd) {
    if (!this.recording) return;
    if (this._pending) {
      this._sections[this._pending] = (this._sections[this._pending] || 0) + (performance.now() - this._lastMark);
      this._pending = null;
    }
    const frameMs = now - this._frameStart;
    const intervalMs = this._prevNow ? now - this._prevNow : 0;
    this._prevNow = now;

    // ---- rolling stats ----
    this._n++;
    this._sumFrameMs += frameMs;
    if (frameMs < this._minFrameMs) this._minFrameMs = frameMs;
    if (frameMs > this._maxFrameMs) this._maxFrameMs = frameMs;
    for (const k in this._sections) this._sumSections[k] = (this._sumSections[k] || 0) + this._sections[k];
    const c = this._counts;
    if (c) for (const k in c) if (c[k] > (this._peakCounts[k] || 0)) this._peakCounts[k] = c[k];
    this._histFrameMs[this._bucket(frameMs)] = (this._histFrameMs[this._bucket(frameMs)] || 0) + 1;

    // ---- decide if this is a "worst" frame worth full detail ----
    // qualifying threshold: worse than the current smallest kept worst frame,
    // OR simply while we haven't filled KEEP_WORST yet.
    const worst = this._worst;
    if (worst.length < KEEP_WORST || frameMs > worst[0].frameMs) {
      // sum of measured sections -> gap = unaccounted (GC / browser / GPU stall)
      let secSum = 0; for (const k in this._sections) secSum += this._sections[k];
      const gapMs = frameMs - secSum;

      // heap + GC detection
      let heapMB = 0, heapDeltaMB = 0;
      const mem = (typeof performance !== 'undefined') && performance.memory;
      if (mem) {
        heapMB = mem.usedJSHeapSize / 1048576;
        heapDeltaMB = this._prevHeap ? heapMB - this._prevHeap : 0;
      }

      // spawn deltas this frame
      let spawned = null;
      if (this._spawnBase && spawnEnd) {
        spawned = {};
        for (const k in spawnEnd) { const d = spawnEnd[k] - this._spawnBase[k]; if (d > 0) spawned[k] = d; }
      }

      // long tasks overlapping this frame window
      const lt = this._longtasks.filter((x) => x.t + x.dur >= this._frameStart - 2 && x.t <= now + 2);
      const longTaskMs = lt.reduce((a, x) => a + x.dur, 0);

      const rec = {
        t: +now.toFixed(1),
        frameMs: +frameMs.toFixed(2),
        intervalMs: +intervalMs.toFixed(2),
        fps: frameMs > 0 ? +(1000 / frameMs).toFixed(0) : 0,
        gapMs: +gapMs.toFixed(2),
        longTaskMs: +longTaskMs.toFixed(1),
        heapMB: +heapMB.toFixed(1),
        heapDeltaMB: +heapDeltaMB.toFixed(1),
        spawned: spawned || {},
        sections: this._round(this._sections),
        counts: c || {},
        likelyCause: this._classify(gapMs, frameMs, longTaskMs, heapDeltaMB, this._sections, spawned),
      };
      this._insertWorst(rec);
    }

    // update prevHeap every frame (cheap) so deltas are accurate
    const mem2 = (typeof performance !== 'undefined') && performance.memory;
    if (mem2) this._prevHeap = mem2.usedJSHeapSize / 1048576;
    this._prevSpawnBase = spawnEnd;
  }

  // heuristic label so the log reads at a glance. Order matters: most specific
  // / most confident signals first.
  _classify(gap, frameMs, longTaskMs, heapDelta, sections, spawned) {
    const big = frameMs >= 8;
    // A large heap DROP means a GC ran this frame and reclaimed memory — the
    // clearest possible GC signature.
    if (heapDelta <= -2) return 'gc pause (heap freed ' + (-heapDelta).toFixed(0) + 'MB)';
    // A large heap GROWTH in a slow frame means heavy allocation churn — this is
    // what *causes* GC pauses a frame or two later. Worth flagging as the source.
    if (big && heapDelta >= 4) return 'alloc churn (heap +' + heapDelta.toFixed(0) + 'MB) — GC pressure';
    // Long Task API fired for most of the frame: definite main-thread stall (GC,
    // layout, or other browser work).
    if (longTaskMs >= frameMs * 0.6) return 'long-task / main-thread stall (' + longTaskMs.toFixed(0) + 'ms)';
    // Time unaccounted by our sections, with no heap signal: browser/compositor
    // or GPU-driver hitch (or a GC the heap counter was too coarse to show).
    if (gap >= frameMs * 0.5 && gap >= 4) return 'unaccounted gap ' + gap.toFixed(0) + 'ms (GC or browser/GPU hitch)';
    const up = sections.update || 0;
    if (up >= frameMs * 0.5 && up >= 3) return (spawned && Object.keys(spawned).length) ? 'update spike + spawn burst' : 'update/simulation spike';
    const en = sections.enemies || 0;
    if (en >= frameMs * 0.4 && en >= 2) return 'enemy render heavy';
    return big ? 'mixed / no dominant section' : 'minor';
  }

  _insertWorst(rec) {
    const w = this._worst;
    // keep sorted ascending by frameMs; w[0] is the smallest "worst" (eviction target)
    let i = w.length;
    w.push(rec);
    while (i > 0 && w[i - 1].frameMs > w[i].frameMs) { const t = w[i - 1]; w[i - 1] = w[i]; w[i] = t; i--; }
    if (w.length > KEEP_WORST) w.shift();
  }

  _bucket(ms) {
    // histogram buckets in ms: <2,2-4,4-6,6-8,8-11,11-16,16-24,24-33,33+
    if (ms < 2) return 0; if (ms < 4) return 1; if (ms < 6) return 2; if (ms < 8) return 3;
    if (ms < 11) return 4; if (ms < 16) return 5; if (ms < 24) return 6; if (ms < 33) return 7; return 8;
  }

  _round(o) { const r = {}; for (const k in o) r[k] = +o[k].toFixed(2); return r; }

  // ---- indicator ----
  drawIndicator(ctx, w) {
    if (!this.recording) return;
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 250);
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.arc(w - 22, 22, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#ffb3b3';
    ctx.textAlign = 'right';
    const worstMs = this._worst.length ? this._worst[this._worst.length - 1].frameMs.toFixed(0) : '0';
    ctx.fillText(`REC ${this._n}f · worst ${worstMs}ms`, w - 34, 26);
    ctx.restore();
  }

  // ---- export ----
  _stopAndExport() {
    this.recording = false;
    this._download(this._buildReport());
  }

  _buildReport() {
    const n = this._n || 1;
    const BUCKET_LABELS = ['<2', '2-4', '4-6', '6-8', '8-11', '11-16', '16-24', '24-33', '33+'];
    const hist = {};
    for (let i = 0; i < BUCKET_LABELS.length; i++) hist[BUCKET_LABELS[i] + 'ms'] = this._histFrameMs[i] || 0;

    const sectionAvgMs = {};
    for (const [k, v] of Object.entries(this._sumSections).sort((a, b) => b[1] - a[1])) sectionAvgMs[k] = +(v / n).toFixed(3);

    // worst frames, most severe first
    const worst = this._worst.slice().sort((a, b) => b.frameMs - a.frameMs);

    // tally the likely causes among the worst frames so the headline is obvious
    const causeTally = {};
    for (const f of worst) causeTally[f.likelyCause] = (causeTally[f.likelyCause] || 0) + 1;

    return {
      summary: {
        frames: this._n,
        avgFrameMs: +(this._sumFrameMs / n).toFixed(3),
        avgCpuFps: this._sumFrameMs > 0 ? +(1000 * n / this._sumFrameMs).toFixed(0) : 0,
        minFrameMs: +this._minFrameMs.toFixed(2),
        maxFrameMs: +this._maxFrameMs.toFixed(2),
        note: 'frameMs = CPU work per frame (update+render); it is a headroom proxy, NOT presented FPS. intervalMs on worst frames is the real frame-to-frame time.',
        frameMsHistogram: hist,
        sectionAvgMs,
        peakCounts: this._peakCounts,
        worstFrameCauses: causeTally,
      },
      worstFrames: worst,
      longTasks: this._longtasks.slice(-KEEP_LONGTASKS),
    };
  }

  _download(report) {
    if (typeof document === 'undefined') return;
    const stamp = new Date(this._startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dreamtide-stutters-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log('[profiler] exported', report.summary);
  }
}

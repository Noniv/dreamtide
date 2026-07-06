// Minimal browser-env stubs so the engine + audio modules load and run
// headlessly. Only update()/simulation paths are exercised — no rendering.
export function setupEnv() {
  const noop = () => {};
  global.window = {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    addEventListener: noop, removeEventListener: noop,
    AudioContext: undefined, webkitAudioContext: undefined,
  };
  global.devicePixelRatio = 1;
  global.performance = global.performance || { now: () => Date.now() };
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

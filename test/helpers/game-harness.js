import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createAudioEnvironment } from './fake-audio.js';
import { createEvent, createFakeDocument, dispatchDocumentEvent } from './fake-dom.js';

const SOURCE_ADAPTER = String.raw`
globalThis.__gameTest = {
  snapshot() {
    return {
      state: {...state}, meta: {...meta}, phase, phaseTime, t, animClock,
      storageReady,
      coins: coins.map(c => ({...c})), sparkles: sparkles.map(s => ({...s})),
      geometry: {W,H,dpr,bW,bH,viewScale,viewX,viewY,viewW,viewH,planet:{...planet},sunR,rbRadius,rbBandW,rbThickness,
        focal:{unicorn:unicornXCss(),pot:potXCss(),rainbow:rainbowFootCss()}},
      muted, choosing, saveClock, resetArmed: !!resetArmed,
    };
  },
  patchState(value) { Object.assign(state, value); upgradeSignature = ''; },
  patchMeta(value) { meta = {...meta, ...value}; upgradeSignature = ''; },
  capMeta(key) {
    let value = 0;
    while (cleanMeta({[key]: value + 1})[key] === value + 1) value++;
    meta = {...meta, [key]: value}; upgradeSignature = '';
    return value;
  },
  setPhase(value, time = 0) { phase = value; phaseTime = time; },
  setTime(value) { t = value; },
  setAnimClock(value) { animClock = value; },
  setEntities(nextCoins = [], nextSparkles = []) { coins = nextCoins.map(c => ({...c})); sparkles = nextSparkles.map(s => ({...s})); },
  update, draw, resize, spawnCoin, burst, updateUpgradeMenu, updateStubbornMenu,
  chaseTarget, chaseRemaining, approachProgress, coinInterval, upgradeCost, upgradeEffect, allUpgradesMaxed,
  catchPrice: CATCH_PRICE,
  enterChoice, startCatch, disarmReset,
  configureCatchReady() {
    for (const key of Object.keys(UPGRADE_MAX)) state[key] = UPGRADE_MAX[key];
    state.money = Math.max(state.money, CATCH_PRICE * 2);
    storageReady = true; phase = 'RUNNING'; upgradeSignature = '';
  },
  ordinaryUpgradeKeys: UPGRADE_INFO.map(info => info[0]),
  permanentKeys: [...META_KEYS],
  renderPart(name) {
    ({sun: () => drawSun(viewX, viewY), unicorn: drawUnicorn, leprechaun: drawRainbowPot,
      coins: drawCoins, sparkles: drawSparkles, clouds: drawClouds, hills: drawFarHills,
      ground: drawGroundDetail, scenery: drawScenery, midground: drawMidground, foreground: drawForeground,
      boot: drawBoot, hud: updateHud})[name]();
  },
  tags() {
    return {world: worldBuffer.__tag, screen: canvas.__tag, sun: sunLayer.__tag,
      planet: planetLayer.__tag, rainbow: rainbowLayer.__tag,
      unicorn: unicornSheet?.__tag, leprechaun: leprechaunSprite.__tag};
  },
};
`;

function seededMath(seed) {
  const math = Object.create(Math);
  let value = seed >>> 0;
  math.random = () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
  return math;
}

function createStorage(initial = {}, { failWrites = false, failReads = false, failOnWrite = 0, failRemovals = false } = {}) {
  const values = new Map(Object.entries(initial));
  const log = [];
  let writeCount = 0;
  return {
    values,
    log,
    getItem(key) {
      log.push({ type: 'get', key });
      if (failReads) throw new Error('Storage read unavailable');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      log.push({ type: 'set', key, value });
      writeCount++;
      if (failWrites || failOnWrite === writeCount) throw new Error('Storage quota exceeded');
      values.set(key, String(value));
    },
    removeItem(key) {
      log.push({ type: 'remove', key });
      if (failWrites || failRemovals) throw new Error('Storage unavailable');
      values.delete(key);
    },
    clear() { log.push({ type: 'clear' }); values.clear(); },
  };
}

function instrumentSource(source) {
  source = source.replace(/^import unicornUrl from .*;\s*/m, match => {
    const replacement = "const unicornUrl='test:unicorn';";
    if (replacement.length > match.length) throw new Error('Test import replacement no longer fits source span');
    return replacement.padEnd(match.length, ' ');
  });
  const end = source.lastIndexOf('})();');
  if (end < 0) throw new Error('Could not find game IIFE boundary for the test adapter');
  return `${source.slice(0, end)}${SOURCE_ADAPTER}\n${source.slice(end)}`;
}

function extractBundleScript(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) throw new Error('No inline script found in production HTML');
  return scripts.map(match => match[1]).join('\n');
}

export async function createGameHarness(options = {}) {
  const {
    source = 'source', width = 240, height = 140, seed = 12345,
    storage: storageValues = {}, failWrites = false, reducedMotion = true,
    rejectAudioResume = false, audioConstructorThrows = false, dpr = 1, transformSource,
    failReads = false, failOnWrite = 0, failRemovals = false, storageUnavailable = false,
    resizeObserverUnavailable = false,
  } = options;
  const document = createFakeDocument({ width, height });
  const clock = { now: 1000 };
  const raf = [];
  const timers = [];
  const microtasks = [];
  const windowListeners = new Map();
  const errors = [];
  const storage = createStorage(storageValues, { failWrites, failReads, failOnWrite, failRemovals });
  const audio = createAudioEnvironment(clock, { rejectResume: rejectAudioResume, constructorThrows: audioConstructorThrows });
  const pendingImages = [];
  const observers = [];

  class FakeImage {
    constructor() { this.__tag = 'unicorn-image'; this.width = 80; this.height = 48; this.onload = null; }
    set src(value) { this._src = value; pendingImages.push(this); }
    get src() { return this._src; }
  }
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() {}
  }

  const addWindowListener = (type, callback, eventOptions) => {
    const listeners = windowListeners.get(type) || [];
    listeners.push({ callback, options: eventOptions });
    windowListeners.set(type, listeners);
  };
  const requestAnimationFrame = callback => { raf.push(callback); return raf.length; };
  let timerId = 0;
  const setTimeoutFake = (callback, delay = 0) => {
    const id = ++timerId;
    timers.push({ id, callback, due: clock.now + delay });
    return id;
  };
  const clearTimeoutFake = id => {
    const index = timers.findIndex(timer => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };

  const globals = {
    console,
    document,
    localStorage: storage,
    AudioContext: audio.AudioContext,
    Image: FakeImage,
    ResizeObserver: resizeObserverUnavailable ? undefined : FakeResizeObserver,
    Math: seededMath(seed),
    performance: { now: () => clock.now },
    requestAnimationFrame,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    queueMicrotask: callback => microtasks.push(callback),
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
    addEventListener: addWindowListener,
    removeEventListener() {},
    devicePixelRatio: dpr,
  };
  if (storageUnavailable) delete globals.localStorage;
  const context = vm.createContext(globals);

  let code;
  if (source === 'bundle') {
    const html = await readFile('dist/index.html', 'utf8');
    code = extractBundleScript(html);
  } else {
    let sourceCode = await readFile('src/game.js', 'utf8');
    if (transformSource) sourceCode = transformSource(sourceCode);
    code = instrumentSource(sourceCode);
  }

  try {
    const filename = source === 'bundle' ? 'dist/index.inline.js' : pathToFileURL(resolve('src/game.js')).href;
    new vm.Script(code, { filename }).runInContext(context);
  } catch (error) {
    errors.push(error);
    throw error;
  }

  const flushMicrotasks = () => {
    let guard = 0;
    while (microtasks.length) {
      if (++guard > 1000) throw new Error('Microtask loop did not settle');
      microtasks.shift()();
    }
  };
  const flushImages = () => {
    for (const image of pendingImages.splice(0)) image.onload?.();
  };
  const settleTimers = (advance = 0) => {
    clock.now += advance;
    let guard = 0;
    while (true) {
      const index = timers.findIndex(timer => timer.due <= clock.now);
      if (index < 0) break;
      if (++guard > 1000) throw new Error('Timer loop did not settle');
      timers.splice(index, 1)[0].callback();
      flushMicrotasks();
    }
  };
  const step = (milliseconds = 16.6667) => {
    clock.now += milliseconds;
    audio.contexts.forEach(audioContext => {});
    const callbacks = raf.splice(0);
    for (const callback of callbacks) {
      try { callback(clock.now); } catch (error) { errors.push(error); throw error; }
    }
    settleTimers();
    flushMicrotasks();
    return callbacks.length;
  };
  const event = (type, target, values = {}) => dispatchDocumentEvent(document, createEvent(type, target, values));
  const windowEvent = (type, values = {}) => {
    const emitted = createEvent(type, values.target || null, values);
    for (const listener of windowListeners.get(type) || []) listener.callback(emitted);
    return emitted;
  };
  const clearCanvasOperations = () => document.canvases.forEach(canvas => canvas.context.clearOperations());
  const operations = tag => document.canvases.find(canvas => canvas.__tag === tag)?.context.operations || [];
  const allOperations = () => document.canvases.flatMap(canvas => canvas.context.operations.map(operation => ({ canvas: canvas.__tag, ...operation })));

  flushMicrotasks();

  return {
    context, game: context.__gameTest, document, storage, audio, errors, clock, raf, timers, observers,
    step, settleTimers, flushMicrotasks, flushImages, event, windowEvent,
    // How many Image loads are still outstanding. The game builds its sprites
    // from text, so this should always be zero.
    pendingImages: () => pendingImages.length,
    element: id => document.elements.get(id),
    clearCanvasOperations, operations, allOperations,
    setDpr(value) { context.devicePixelRatio = value; },
    resize(widthValue, heightValue) {
      const canvas = document.elements.get('c');
      canvas.clientWidth = widthValue;
      canvas.clientHeight = heightValue;
      for (const observer of observers) observer.callback([{ target: canvas }]);
    },
  };
}

export const SAVE_KEY = 'js13k2026:kieran:unicorn-rainbow-chase:save:v2';
export const LEGACY_SAVE_KEY = 'js13k2026:kieran:unicorn-rainbow-chase:prestige:v1';

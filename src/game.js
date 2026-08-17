(() => {
'use strict';

// Maths helpers are used dozens of times each by the renderer. Unpacking them
// from `Math` once lets every call site read exactly as it did before while
// the shipped bundle carries the bare name — a minifier cannot do this for us,
// because it is not allowed to assume anything about a global object.
const { abs, ceil, cos, floor, hypot, max, min, pow, random, round, sign, sin, sqrt, PI } = Math;

// ============================================================
// DOM references
//
// Every element the game drives is grabbed once, up front, by id. Writing it
// as a single id list keeps the ids — the part that actually has to match the
// markup — in one readable place, and keeps the lookup call out of the bundle
// forty-odd times over. The destructured names below line up positionally
// with the ids, so the two lists must stay in the same order.
// ============================================================

const [
  canvas, hud, hudMoney, hudUpgrade, upgradeMenu, upgradeTitle, upgradeBio, upgradeClose,
  gameVolume, gameNew, upgradeList, upgradeScrollCue,
  upgradeMore, upgradeMoney, upgradeChase, catchButton, catchRequirement, stubbornMenu,
  stubbornList, stubbornProfileTitle, stubbornProfileBio, stubbornDescription,
  stubbornCatches, stubbornStatus,
] = `c hud hud-money hud-upgrade upgrade-menu upgrade-title upgrade-bio upgrade-close
game-volume game-new upgrade-list upgrade-scroll-cue
upgrade-more upgrade-money upgrade-chase catch-rainbow catch-requirement stubborn-menu
stubborn-list stubborn-profile-title stubborn-profile-bio stubborn-description
stubborn-catches stubborn-status`.split(/\s+/).map(id => document.getElementById(id));

// The one class-based lookup: a scroll container with no reason to carry an
// id of its own.
const stubbornBody = document.querySelector('.sbody');
const screenCtx = canvas.getContext('2d');

// The world is real pixel art: everything is drawn as whole pixels into
// this low-res buffer (1 unit = 1 chunky pixel), then blitted to the
// screen at an integer scale with smoothing off. No gradients, no
// antialiased curves, no glows — just palette colours on a grid, exactly
// like the unicorn sprite.
const worldBuffer = document.createElement('canvas');
const ctx = worldBuffer.getContext('2d');

// The ground never moves, so it's prerendered here once per resize.
const planetLayer = document.createElement('canvas');

// The rainbow is a fixed focal anchor. Its arch is prerendered with the foot
// at the layer's left edge and baseline at the bottom, then planted beside
// the safely positioned pot group.
const rainbowLayer = document.createElement('canvas');
let rbRadius = 0, rbBandW = 0, rbThickness = 0;

// The sky, the sun's disc and the cloud shapes are static too, so they're
// prerendered per resize — which makes dithered colour transitions (the
// pixel-art stand-in for gradients) affordable everywhere.
const skyLayer = document.createElement('canvas');
const sunLayer = document.createElement('canvas');
let sunR = 0;
let cloudLayers = [];
let hillLayers = [];

// Several things in the world are short lists of hand-placed pixels: the
// leprechaun's leg poses, the fern's curling fronds. Each list is stored as a
// string of two-character points — a base-36 digit for the x offset from the
// given origin, then one for the y offset — because two characters per pixel
// instead of a ten-character function call is worth most of a kilobyte of
// source across all of them, and `parseInt(c, 36)` reads them straight back.
// Offsets must therefore be non-negative, so callers pass an origin far
// enough up and to the left that every point lands in range.
const pixels = (list, x, y) => {
  const points = [];
  for (let i = 0; i < list.length; i += 2)
    points.push([x + parseInt(list[i], 36), y + parseInt(list[i + 1], 36)]);
  return points;
};

// ============================================================
// Tunables
// ============================================================

const FOCAL_INSET_MIN = 0.15;
const FOCAL_INSET_MAX = 0.25;
const FOCAL_INSET_MIN_WIDTH = 360;
const FOCAL_INSET_MAX_WIDTH = 1440;
const FOCAL_MARGIN = 2;          // safety margin in world pixels
const APPROACH_GAP = 5;          // world pixels between unicorn and pot at 100%
const RAINBOW_CHASE = 204;       // abstract progress in a complete run
const MAX_UNLOCK_PROGRESS = RAINBOW_CHASE - 25;
const PRICE_GROWTH = 1.125;
const MAX_COINS = 32;
const MAX_SPARKLES = 160;
const STARTING_MONEY = 0;
const CATCH_PRICE = 1000;
const THROW_TIME = 0.8;
const TUMBLE_TIME = 2;
const SAVE_KEY = 'js13k2026:kieran:unicorn-rainbow-chase:save:v2';
const LEGACY_SAVE_KEY = 'js13k2026:kieran:unicorn-rainbow-chase:prestige:v1';

// The two persisted key sets. `META_ALL` is every field of the permanent
// record (the two counters first, then the three Stubbornness traits, which
// are the only ones a player can choose); `META_KEYS` is that choosable tail.
const META_ALL = ['points', 'catches', 'drop', 'value', 'chase'];
const META_KEYS = META_ALL.slice(2);

// One row per ordinary upgrade: save key, display name, the sentence its
// effect readout completes, and its blurb.
// Everything else about an upgrade — its price curve and its ceiling — is
// uniform, so it lives in the two maps below rather than being repeated.
//
// Only the first row exists in the markup; the rest are cloned from it at
// startup and filled in from here. Writing all three out in full would mean
// shipping the same forty-element row shape three times over.
const UPGRADE_INFO = [
  ['mane', 'Shimmering Mane', 'Gold drops every', 'Dazzle the leprechaun so he drops gold more often.'],
  ['sparkle', 'Sparkle Surprise', 'Gold per pickup', 'Enchant each dropped gold to make it more valuable.'],
  ['gallop', 'Majestic Gallop', 'Her gallop feels', 'Bound towards the rainbow and close the gap in style.'],
];

// The same idea for the three permanent Stubbornness choices. The first card
// is in the markup; these two are cloned from it.
const STUBBORN_INFO = [
  ['value', 'Selective Memory', 'Every pickup is permanently worth one more gold.'],
  ['chase', 'Refuses to Quit', 'Upgrades cost 5% less in every future run.'],
];
const UPGRADE_BASE = { mane: 12, sparkle: 20, gallop: 40 };
const UPGRADE_MAX = { mane: 10, sparkle: 10, gallop: 10 };

const initialRun = () => ({ money: STARTING_MONEY, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 });

// Storage is shared with every other page on the origin, so nothing read back
// out of it is trusted. These two shared guards are the only way a loaded
// number reaches gameplay: anything missing, fractional, negative, absurd or
// simply not a number is replaced by a safe default rather than rejected, so
// a partially damaged record still yields a playable game.
const whole = (value, limit, fallback = 0) =>
  Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : fallback;
const finite = (value, limit) =>
  Number.isFinite(value) && value >= 0 && value <= limit ? value : 0;

/** Reject malformed shared-origin storage without touching any other game's data. */
function cleanMeta(value) {
  const clean = {};
  for (const key of META_ALL) clean[key] = whole(value?.[key], 999);
  return clean;
}

/** Clamp a loaded run to values the current build can produce safely. */
function cleanRun(value) {
  const clean = {
    money: whole(value?.money, 1e12, STARTING_MONEY),
    distance: finite(value?.distance, 1e9),
    approach: 0,
    coinClock: finite(value?.coinClock, 60),
  };
  for (const [key] of UPGRADE_INFO) clean[key] = whole(value?.[key], UPGRADE_MAX[key]);
  // Chase progress is re-derived rather than trusted: a save claiming more
  // progress than its upgrade levels could ever have bought is pulled back.
  clean.approach = min(finite(value?.approach, MAX_UNLOCK_PROGRESS), chaseCeiling(clean));
  return clean;
}

/**
 * Read without creating a save; a present v2 record always shadows legacy
 * data. Returns the record plus whether storage is usable at all — a browser
 * with storage blocked still gets a playable (if unsaveable) game, and the
 * first autosave is what migrates a legacy record forward.
 */
function loadSave() {
  const fresh = { meta: cleanMeta(), run: initialRun() };
  try {
    const current = localStorage.getItem(SAVE_KEY);
    if (current !== null) {
      const parsed = JSON.parse(current);
      const valid = parsed && typeof parsed === 'object' && parsed.meta && parsed.run;
      return [valid ? { meta: cleanMeta(parsed.meta), run: cleanRun(parsed.run) } : fresh, true];
    }
    const legacy = localStorage.getItem(LEGACY_SAVE_KEY);
    if (legacy !== null) return [{ meta: cleanMeta(JSON.parse(legacy)), run: initialRun() }, true];
    return [fresh, true];
  } catch {
    return [fresh, false];
  }
}

let [loadedSave, storageReady] = loadSave();
let meta = loadedSave.meta;

let audio, audioOut, muted = false;

/** Start immediately where allowed, then retry from any gesture for mobile autoplay policies. */
function startAudio() {
  if (!audio) {
    audio = new AudioContext();
    audioOut = audio.createGain();
    audioOut.connect(audio.destination);
  }
  if (audio.state !== 'running') {
    const silence = audio.createBufferSource();
    silence.buffer = audio.createBuffer(1, 1, 22050);
    silence.connect(audioOut);
    silence.start();
    audio.resume().catch(() => {});
  }
}
startAudio();
for (const event of ['pointerdown', 'touchstart', 'keydown']) addEventListener(event, startAudio, { passive: true });
document.addEventListener('visibilitychange', () => !document.hidden && startAudio());

const soundTimes = {};
const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
const SOUNDS = {
  click: [[2600, 0, .03, .05]],
  sparkle: [[1760, 0, .09, .023], [2217, .045, .09, .02], [2637, .09, .1, .019], [3520, .135, .12, .016]],
  whoosh: [[900, 0, .65, .018, 140, 2]],
  whack: [[150, 0, .14, .08, 60, 1], [900, 0, .04, .035, 180, 2]],
  tumble: [[700, .08, .18, .025, 420, 3], [520, .42, .18, .023, 300, 3], [380, .76, .24, .02, 180, 3]],
};
const MUSIC = [523, 659, 784, 0, 880, 784, 659, 0, 587, 659, 784, 880, 1047, 0, 880, 784, 0, 659, 587, 659, 784, 0, 523, 0];
let musicStep = 0, musicAt = 0;

function playNote(frequency, start, duration, volume, wave = 'sine', endFrequency = frequency) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + .003);
  gain.gain.exponentialRampToValueAtTime(.001, start + duration);
  oscillator.connect(gain).connect(audioOut);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

/** Play a throttled oscillator recipe whenever audio is active. */
function playSound(name) {
  if (!audio || muted) return;
  const now = audio.currentTime;
  if (now - (soundTimes[name] ?? -1) < .03) return;
  soundTimes[name] = now;
  for (const [frequency, offset, duration, volume, end = frequency, wave = 0] of SOUNDS[name]) playNote(frequency, now + offset, duration, volume, WAVES[wave], end);
}

/** Keep a short music horizon so background tabs cannot queue a burst of notes. */
function scheduleMusic() {
  if (!audio || muted || phase === 'THROW' || phase === 'TUMBLE') return;
  const now = audio.currentTime;
  if (!musicAt || musicAt < now - .1) musicAt = now + .05;
  while (musicAt < now + .2) {
    const frequency = MUSIC[musicStep++ % MUSIC.length];
    if (frequency) playNote(frequency, musicAt, .3, .007, 'triangle');
    musicAt += .34;
  }
}

const GALLOP_FEEL = ['Steady', 'Sprightly', 'Brisk', 'Bold', 'Dashing', 'Swift', 'Spirited', 'Radiant', 'Majestic', 'Legendary', 'Unstoppable'];
const upgradeCost = (key, level) => max(1, floor(UPGRADE_BASE[key] * pow(PRICE_GROWTH, level) * pow(.95, meta.chase)));
const coinInterval = level => max(0.25, 1 / ((0.4 + min(level, 10) * 0.16) * (1 + meta.drop * 0.2)));

/** Return the current and next visible effect for an upgrade level. */
function upgradeEffect(key, level) {
  if (key === 'mane') {
    const interval = value => `${+coinInterval(value).toFixed(2)}s`;
    return [interval(level), interval(level + 1)];
  }
  if (key === 'sparkle') return [level + 1, level + 2];
  return [GALLOP_FEEL[level], GALLOP_FEEL[level + 1]];
}
const UNICORN_PROFILES = [
  ['Starlight', 'Collects wishes and shiny things.'],
  ['Moonbeam', 'Powered by moonlight and marshmallows.'],
  ['Sparklehoof', 'Leaves a little magic everywhere.'],
  ['Glitterbell', 'Never met a rainbow she could not chase.'],
  ['Princess Twinkle', 'Royal, radiant, and ready to gallop.'],
];
const unicornProfile = UNICORN_PROFILES[random() * UNICORN_PROFILES.length | 0];
upgradeTitle.textContent = stubbornProfileTitle.textContent = unicornProfile[0];
upgradeBio.textContent = stubbornProfileBio.textContent = unicornProfile[1];
stubbornDescription.textContent = `Nothing can dampen ${unicornProfile[0]}'s glittery spirit. She always comes back with a new trick.`;

const RAINBOW_COLOURS = ['#f66f93', '#f6a453', '#ffe477', '#73d584', '#59abea', '#8170df', '#bd72d9'];
// Pick one of three stepped pixel-ray silhouettes for this page load. It never
// changes or pulses, keeping the sky calm and avoiding per-frame variation.
const SUN_RAYS = ['10312111121301', '1031111301', '20312122121302']
  .map(pattern => pixels(pattern, 0, 0));
const sunRay = random() * 3 | 0;
const TREE_PALETTES = [
  ['#ffb8bd', '#ed8f99'], ['#ffd0a2', '#e8ac78'], ['#ffe99e', '#e2c66c'],
  ['#b6f0c8', '#93dcae'], ['#a9d7f2', '#84b9d9'], ['#bdc8fa', '#9ba8df'],
  ['#d9c8ff', '#bfa9ef'],
];
// The world is authored on a 3px grid. Landscape scenes use a 4× integer
// crop for a closer view; portrait and square scenes show the full 3× world.
const PIXEL_SIZE = 3;
const VIEW_PIXEL_SIZE = 4;
const CAMERA_X = 0.47;
const CAMERA_Y = 0.62;

// Unicorn gallop: five 16x16 frames laid out left to right, authored as
// palette characters in exactly the same way as the leprechaun below. Shipping
// the artwork as text rather than as a PNG means the entry carries no binary
// asset at all — and because the five frames differ only around the legs and
// mane, the compressor models the repetition far better than it can model the
// base64 of an already-compressed image.
const SPRITE_FRAME = 16;
const SPRITE_FRAMES = 5;
const WALK_FPS = 10;

const UNICORN_PALETTE = {
  a: '#e3e6ff',  // coat
  b: '#caccdf',  // coat shade
  c: '#f1d05f',  // horn and hoof gold
  d: '#42e0d3',  // mane + tail: teal
  e: '#98e67d',  // green
  f: '#e86a73',  // pink
  g: '#ee8540',  // orange
  h: '#cdf7e2',  // highlight
  i: '#92dcba',  // highlight shade
  j: '#f5a097',  // muzzle
  k: '#5daf8d',  // deep tail shade
  l: '#141013',  // eye
};
const UNICORN_SHEET = [
  '................................................................................',
  '..............................................h...............h.................',
  '.............................................i...............i................h.',
  '..............h...............h...........bbk.............bbk................i..',
  '.............i...............i...........babb............babb.............bbk...',
  '..........bbk.............bbk............aalaa...........aalaa...........babb...',
  '.........babb............babb............ajaaa...........ajaaa...........aalaa..',
  '.........aalaa...........aalaa....ee..bbbaaaa.....cc..bbbaaaa............ajaaa..',
  '..ff..bbbajaaa....dd..bbbajaaa...eddebaaaaaaa....ceecbaaaaaaa.....gg..bbbaaaa...',
  '.fggfbaaaaaaa....dffdbaaaaaaa....edfbaaaaaaaa....cedbaaaaaaaa....gccgbaaaaaaa...',
  '.fgcaaaaaaaaa....dfgaaaaaaaaa....edgaaaaaaaab....cefbaaaaaaab....gceaaaaaaaaa...',
  '.fgeaaaaaaaab....dfcaaaaaaaab...edfgaaaaaaaa....cedfaaaaaaaa.....gcdaaaaaaaab...',
  'fgceaaaaaaab....dfgcaaaaaaab....edfcaabaaabaa...cedgaaabbbbaa...gcedaaaaaaab....',
  'fgcdbaaabaa.....dfgebaaabbaa....dfgcab.....ba...edfgab.....ba...ccefbaaabbaa....',
  'gced.ba.baa.....fgcebaa..baa........b...............a...........cedfbaa...ba....',
  '......b..b..........ba...ba..........................................ba....ba...',
];

const SPRITE_CELL = SPRITE_FRAME + 2;

// Every offscreen surface in the game is a pixel canvas that gets sized and
// then drawn into, and setting either dimension is also how a layer is
// cleared before a re-render — so sizing and grabbing the context are one
// step. Pass an existing canvas to resize it in place.
function sized(w, h, canvas = document.createElement('canvas')) {
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext('2d')];
}

// Stamping a shape once at each of its four orthogonal neighbours is how
// every outline in the game is made — offset copies underneath, the original
// on top. Both the sprite haloer below and the leprechaun's dancing shins use
// this list, and both use the same dark plum for the halo itself.
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OUTLINE = '#7d5f94';

// A dark halo stamped around a sprite's silhouette so it reads against the
// pastel world. `pad` grows the canvas to make room for the halo; the unicorn
// sheet passes 0 because its frames are already padded into roomy cells and a
// larger canvas would shift every frame's origin.
function outlined(src, pad = 1) {
  const [silhouette, sg] = sized(src.width, src.height);
  sg.drawImage(src, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = OUTLINE;
  sg.fillRect(0, 0, src.width, src.height);

  const [out, og] = sized(src.width + pad * 2, src.height + pad * 2);
  for (const [dx, dy] of NEIGHBOURS) og.drawImage(silhouette, pad + dx, pad + dy);
  og.drawImage(src, pad, pad);
  return out;
}

function buildOutlinedSheet(img) {
  const [padded, pg] = sized(SPRITE_FRAMES * SPRITE_CELL, SPRITE_CELL);
  for (let c = 0; c < SPRITE_FRAMES; c++) {
    pg.drawImage(img, c * SPRITE_FRAME, 0, SPRITE_FRAME, SPRITE_FRAME,
                 c * SPRITE_CELL + 1, 1, SPRITE_FRAME, SPRITE_FRAME);
  }
  return outlined(padded, 0);
}

// Build a tiny sprite from rows of palette characters ('.' = transparent).
// Hand-placed pixels as code — characters cost bytes of text, not assets.
function spriteFromMap(rows, palette) {
  const [c, g] = sized(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const colour = palette[row[x]];
      if (colour) {
        g.fillStyle = colour;
        g.fillRect(x, y, 1, 1);
      }
    }
  });
  return c;
}

// Both characters are built the same way: a character map painted into a
// canvas, then a halo stamped around the silhouette. The unicorn's frames go
// into 18x18 cells first so one frame's halo cannot bleed into the next.
const unicornSheet = buildOutlinedSheet(spriteFromMap(UNICORN_SHEET, UNICORN_PALETTE));

// The dialog headers show a round portrait of the unicorn. It is a magnified
// crop of this very canvas, handed to CSS as a data URL, so the artwork is
// still only described once anywhere in the entry.
document.documentElement.style.setProperty('--sheet', `url(${unicornSheet.toDataURL()})`);

// The leprechaun, facing the player: hat with buckle, two eyes, orange
// beard framing the face, green coat and buckled belt. Lit from the
// top-left like everything else — each material has a shade tone along
// its right/under edge, just inside the outline.
//
// His arms are set on his hips and never move — that rigid upper body over
// bouncing feet is the whole silhouette of Irish dancing, so the arms live
// in the sprite rather than being animated. The shoulders stay narrow so
// the elbow row is the widest part of him and reads as akimbo, with the
// hands tucked onto the belt. Only the legs below are procedural.
const leprechaunSprite = outlined(spriteFromMap([
  '...hhhhi...',
  '..hhhhhhi..',
  '..hhhhhhi..',
  '..HHyHHHH..',
  '.hhhhhhhhi.',
  '...sssss...',
  '..bsesesb..',
  '..bssssfb..',
  '..bbbbbcc..',
  '...bbbbc...',
  '.gggbbcggd.',
  'gggggggggdd',
  '.sHHyHHHdf.',
  '..gggggd...',
  '..pp...pp..',
  '..kk...kk..',
], {
  h: '#4fc06a',  // hat
  i: '#3d9c55',  // hat shade
  H: '#2c7a44',  // hat band + belt
  y: '#ffd54a',  // buckles
  s: '#ffcf9e',  // face
  f: '#f0b183',  // face shade
  e: '#54385f',  // eyes
  b: '#ff9b4a',  // beard
  c: '#e07f35',  // beard shade
  g: '#3aa057',  // coat
  d: '#2f8749',  // coat shade
  p: '#7a4a2e',  // legs
  k: '#3b3547',  // shoes
}));

// ============================================================
// Game state
// ============================================================

const state = { ...loadedSave.run };

/** Commit one complete record before exposing any candidate state to gameplay. */
function commitGame(nextMeta = meta, nextRun = state) {
  const candidate = { meta: cleanMeta(nextMeta), run: cleanRun(nextRun) };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(candidate));
  } catch {
    storageReady = false;
    return false;
  }
  meta = candidate.meta;
  Object.assign(state, candidate.run);
  storageReady = true;
  return true;
}

const commitMeta = next => commitGame(next, state);

let W = 0, H = 0, dpr = 1;       // screen-space size (CSS pixels)
let bW = 0, bH = 0;              // authored world buffer size
let viewScale = PIXEL_SIZE;      // integer CSS pixels per visible world pixel
let viewX = 0, viewY = 0;        // visible source origin in world pixels
let viewW = 0, viewH = 0;        // visible source size in world pixels
let t = 0;                       // elapsed animation time (s)
let last = performance.now();
let animClock = 0;               // drives the automatic walking frames
let coins = [];
let sparkles = [];
let phase = meta.points ? 'CHOICE' : 'RUNNING';
let phaseTime = 0;
let catchProgress = 0;
let choosing = false;
let saveClock = 2;

/** Start a fresh run while preserving the separately persisted prestige state. */
function resetRun() {
  Object.assign(state, initialRun());
  coins = [];
  sparkles = [];
  animClock = 0;
  upgradeSignature = '';
}

// ============================================================
// Canvas sizing + world geometry
// ============================================================

// The ground is the top of a huge circle (the "planet"), so the world reads
// as a small curved globe. The apex of the hill sits at a fixed fraction of
// the height and the ground drops a bounded amount from the centre to the
// screen edge; the radius is derived from those two constraints, so no
// screen shape lets the hill swallow the viewport.
let planet = { cx: 0, cy: 0, r: 0 };

function updateGeometry() {
  const apexY = H * 0.62;
  const halfW = W / 2;
  const edgeDrop = max(24, min(H * 0.18, W * 0.12));
  // Circle through the apex with the requested drop at the screen edges:
  // r² - halfW² = (r - drop)²  =>  r = (halfW² + drop²) / (2·drop)
  const r = (halfW * halfW + edgeDrop * edgeDrop) / (2 * edgeDrop);
  planet = { cx: W / 2, cy: apexY + r, r };
}

// Ground height in CSS pixels / in world-buffer pixels
function worldY(x) {
  const dx = x - planet.cx;
  return planet.cy - sqrt(max(1, planet.r * planet.r - dx * dx));
}
const toB = v => v / PIXEL_SIZE;
const wyB = x => worldY(x * PIXEL_SIZE) / PIXEL_SIZE;

// View geometry is calculated once per resize and shared by drawing,
// placement and effects. Orientation is the only zoom decision.
function updateView() {
  viewScale = W > H ? VIEW_PIXEL_SIZE : PIXEL_SIZE;
  viewW = min(bW, ceil(W / viewScale));
  viewH = min(bH, ceil(H / viewScale));
  viewX = max(0, min(bW - viewW, round(bW * CAMERA_X - viewW / 2)));
  viewY = max(0, min(bH - viewH, round(bH * CAMERA_Y - viewH * CAMERA_Y)));
}

const visibleXCss = fraction => (viewX + viewW * fraction) * PIXEL_SIZE;
const clamp = (value, low, high) => max(low, min(high, value));

function focalInset() {
  const progress = clamp(
    (W - FOCAL_INSET_MIN_WIDTH) / (FOCAL_INSET_MAX_WIDTH - FOCAL_INSET_MIN_WIDTH),
    0, 1
  );
  return FOCAL_INSET_MIN + (FOCAL_INSET_MAX - FOCAL_INSET_MIN) * progress;
}

// How much of the chase a given set of upgrade levels could possibly have
// closed. The live target and the save sanitiser both need it, so it takes
// the run as an argument; it is a hoisted declaration because loading a save
// happens long before this point in the file.
function chaseCeiling(run) {
  return min(MAX_UNLOCK_PROGRESS, (run.mane + run.sparkle) * 2.95 + run.gallop * 12);
}
const chaseTarget = () => chaseCeiling(state);
const approachProgress = () => min(1, state.approach / RAINBOW_CHASE);
const chaseRemaining = () => max(0, ceil(RAINBOW_CHASE - state.approach));


// The complete pot/leprechaun pair is the right-hand anchor. Its actual
// bounds are used so even an extremely narrow pane retains a safety margin.
const POT_GROUP_LEFT = -7;
const POT_GROUP_RIGHT = 3 + leprechaunSprite.width;
function potXCss() {
  const margin = FOCAL_MARGIN * PIXEL_SIZE;
  const visibleLeft = viewX * PIXEL_SIZE + margin;
  const visibleRight = (viewX + viewW) * PIXEL_SIZE - margin;
  const groupCentre = visibleXCss(1 - focalInset());
  const centreOffset = (POT_GROUP_LEFT + POT_GROUP_RIGHT) * PIXEL_SIZE / 2;
  const x = clamp(
    groupCentre - centreOffset,
    visibleLeft - POT_GROUP_LEFT * PIXEL_SIZE,
    visibleRight - POT_GROUP_RIGHT * PIXEL_SIZE
  );
  return round(x / PIXEL_SIZE) * PIXEL_SIZE;
}

// The arch is derived from the fixed pot, never from travel or time.
function rainbowFootCss() {
  return potXCss() - (rbThickness * PIXEL_SIZE) / 2 + PIXEL_SIZE;
}

function unicornStartCss() {
  const halfSprite = SPRITE_CELL / 2;
  const visibleLeft = (viewX + FOCAL_MARGIN + halfSprite) * PIXEL_SIZE;
  const visibleRight = (viewX + viewW - FOCAL_MARGIN - halfSprite) * PIXEL_SIZE;
  return clamp(visibleXCss(focalInset()), visibleLeft, visibleRight);
}

// During the tumble, normalized progress keeps both endpoints responsive to resize.
function unicornXCss() {
  const start = unicornStartCss();
  const target = max(
    start,
    potXCss() - (7 + APPROACH_GAP + SPRITE_CELL / 2) * PIXEL_SIZE
  );
  const tumble = min(1, phaseTime / TUMBLE_TIME);
  const progress = phase === 'TUMBLE' ? catchProgress * pow(1 - tumble, 3) : phase === 'CHOICE' ? 0 : approachProgress();
  return start + (target - start) * progress;
}

function resize() {
  // Full device resolution — a capped/fractional backing store makes the
  // browser rescale with smoothing, which shimmers on dithered pixels
  const newDpr = devicePixelRatio || 1;
  const newW = canvas.clientWidth;
  const newH = canvas.clientHeight;
  // ResizeObserver can fire without a real change — skip the rebuild
  if (newW === W && newH === H && newDpr === dpr && worldBuffer.width > 1) return;

  // Preserve in-flight objects in visible space across resize and
  // orientation changes.
  const oldLeft = viewX * PIXEL_SIZE;
  const oldTop = viewY * PIXEL_SIZE;
  const oldWidth = viewW * PIXEL_SIZE;
  const oldHeight = viewH * PIXEL_SIZE;

  dpr = newDpr;
  W = newW;
  H = newH;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  screenCtx.imageSmoothingEnabled = false; // chunky upscale, not blurry

  bW = max(1, ceil(W / PIXEL_SIZE));
  bH = max(1, ceil(H / PIXEL_SIZE));
  worldBuffer.width = bW;
  worldBuffer.height = bH;
  ctx.imageSmoothingEnabled = false;

  updateView();
  if (oldWidth > 0 && oldHeight > 0) {
    const left = viewX * PIXEL_SIZE;
    const top = viewY * PIXEL_SIZE;
    const fx = viewW * PIXEL_SIZE / oldWidth;
    const fy = viewH * PIXEL_SIZE / oldHeight;
    for (const c of coins) {
      c.x = left + (c.x - oldLeft) * fx;
      c.vx *= fx;
    }
    for (const s of sparkles) {
      s.x = left + (s.x - oldLeft) * fx;
      s.y = top + (s.y - oldTop) * fy;
      s.vx *= fx;
      s.vy *= fy;
    }
  }

  updateGeometry();
  renderSkyLayer();
  renderSunLayer();
  renderCloudLayers();
  renderHillLayers();
  renderPlanetLayer();
  renderRainbowLayer();
}

// One random world per page load, then stable pseudo-random results so
// scrolling scenery never changes colour or shape while it is on screen.
const worldSeed = random() * 9999;
function hash(n) {
  const s = sin((n + worldSeed) * 127.1) * 43758.5453;
  return s - floor(s);
}

// ============================================================
// Entities
// ============================================================

// Coins spill out of the pot: launched up and toward the player, they arc
// under gravity, bounce, then settle at restH above the ground and scroll
// along with the world. `vigour` scales the launch for future burst events.
function spawnCoin(vigour = 1) {
  const potX = potXCss();
  coins.push({
    x: potX + (random() - 0.5) * 10,
    h: 36,                                        // the pot's mouth height
    vx: -(30 + random() * 130) * vigour,
    vh: (130 + random() * 170) * min(vigour, 1.4),
    restH: 6 + random() * 50,
    settled: false,
    phase: random() * PI * 2,
  });

  // Loose gold chips spray from the rim with each full-sized coin.
  burst(potX, worldY(potX) - 30, 6,
    ['#ffec8a', '#ffd54a', '#e6a817'], 1.15, true);
}

function burst(x, y, count, colours, power = 1, fountain = false) {
  count = min(count, MAX_SPARKLES - sparkles.length);
  for (let i = 0; i < count; i++) {
    const angle = random() * PI * 2;
    const speed = (70 + random() * (fountain ? 90 : 170)) * power;
    sparkles.push({
      x, y,
      vx: fountain ? (random() - 0.5) * speed : cos(angle) * speed,
      vy: fountain ? -60 - random() * speed : sin(angle) * speed * 0.5 - 110 * power,
      life: 0.65 + random() * 0.75,
      r: fountain ? 2 + random() * 3 : 3 + random() * 6,
      colour: colours[i % colours.length],
      gold: fountain,
    });
  }
}

// ============================================================
// Update
// ============================================================

function update(dt) {
  t += dt;
  if (phase === 'THROW') {
    phaseTime += dt;
    if (phaseTime >= THROW_TIME) {
      phase = 'TUMBLE';
      phaseTime = 0;
      playSound('whack');
      playSound('tumble');
    }
    return;
  }
  if (phase === 'TUMBLE') {
    phaseTime += dt;
    if (phaseTime >= TUMBLE_TIME) enterChoice();
    return;
  }
  if (phase === 'CHOICE') return;

  saveClock -= dt;
  if (saveClock <= 0) {
    commitGame();
    saveClock = 2;
  }

  animClock += dt * WALK_FPS;

  // Travel keeps the world moving, but only purchased upgrades close the chase.
  const travel = 18 * dt;
  state.distance += travel;

  // Realise three banked chase steps per second, including while menus are open.
  const approachTarget = chaseTarget();
  state.approach = min(approachTarget, state.approach + dt * 3);

  // Shimmering Mane increases visible drops without allowing a particle flood.
  state.coinClock -= dt;
  if (state.coinClock <= 0) {
    if (coins.length < MAX_COINS) spawnCoin();
    state.coinClock = coinInterval(state.mane);
  }

  // --- Coin scrolling, proximity pull and collection ---
  const ux = unicornXCss();
  // The pickup point is the unicorn's forward shoulder/muzzle, not a large
  // invisible radius in front of the sprite.
  const collectX = ux + 5 * PIXEL_SIZE;
  const collectY = worldY(ux) - 8 * PIXEL_SIZE;
  const collectRange = 5 * PIXEL_SIZE;
  const pullRange = 38;

  for (const c of coins) {
    c.x -= travel * 1.6;
    if (!c.settled) {
      c.x += c.vx * dt;
      c.vh -= 520 * dt;                          // gravity
      c.h += c.vh * dt;
      if (c.vh < 0 && c.h <= c.restH) {          // bounce, then settle
        c.h = c.restH;
        c.vh = -c.vh * 0.45;
        c.vx *= 0.6;
        if (c.vh < 40) c.settled = true;
      }
    }
  }

  coins = coins.filter(c => {
    const cy = worldY(c.x) - c.h;
    const dx = c.x - collectX;
    const dy = cy - collectY;
    const d = hypot(dx, dy);
    if (d < collectRange) {
      state.money += 1 + state.sparkle + meta.value;
      playSound('sparkle');
      burst(collectX, collectY, 14,
        ['#fffbe8', '#ffe05b', '#ff8acb', '#8fd7ff', '#a986ff'], 0.9);
      return false;
    }
    if (d < pullRange * 3) {
      // Pull all the way into the sprite and damp the coin's ballistic motion.
      const pull = min(1, dt * 4.2);
      c.x += (collectX - c.x) * pull;
      c.h += (worldY(c.x) - collectY - c.h) * pull;
      c.vx *= 1 - pull;
      c.vh *= 1 - pull;
    }
    return c.x > -30;
  });

  // The pot stays fixed while upgrade levels determine the unicorn's approach.

  // --- Sparkles ---
  for (const s of sparkles) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 260 * dt;
    s.life -= dt;
  }
  sparkles = sparkles.filter(s => s.life > 0);
}

// ============================================================
// Pixel-art helpers
// All coordinates below are in WORLD-BUFFER pixels (the chunky grid).
// ============================================================

function pset(x, y, colour) {
  ctx.fillStyle = colour;
  ctx.fillRect(x | 0, y | 0, 1, 1);
}

// 4×4 Bayer ordered dither: 16 blend levels, used by the sky, sun, turf
// and hills so every gradient in the world dissolves the same way
const BAYER = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];
const dither4 = (x, y) => (BAYER[y & 3][x & 3] + 0.5) / 16;

// Pick a tone index for value v (in 0..n-1), dithering only a narrow
// fraction of each band edge. Strength stays adjustable for materials such
// as the sun that benefit from a slightly softer transition.
function shadeIndex(v, n, x, y, strength = 0.25) {
  const idx = floor(v + 0.5 + (dither4(x, y) - 0.5) * strength);
  return max(0, min(n - 1, idx));
}

function rectB(x, y, w, h, colour) {
  ctx.fillStyle = colour;
  ctx.fillRect(round(x), round(y), max(1, round(w)), max(1, round(h)));
}

// Every soft gradient in this world is the same operation: walk a rectangle,
// turn each pixel's position into a depth running 0 (first tone) to 1 (last
// tone), and paint the tone that depth lands on — with the Bayer pattern
// nudging pixels either side of each band edge so the boundary dissolves
// instead of drawing a hard line. The sky, the sun's disc, the turf and the
// far hills differ only in how they measure depth, so `depthAt` is the one
// thing each caller supplies. A negative depth leaves the pixel alone, which
// is how the sun keeps the corners of its square canvas transparent and how
// the hills leave open sky above their crest.
function ditherFill(g, w, h, tones, strength, depthAt) {
  const last = tones.length - 1;
  let previous = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const depth = depthAt(x, y);
      if (depth < 0) continue;
      const tone = shadeIndex(depth * last, tones.length, x, y, strength);
      // Assigning fillStyle re-parses the colour string every time, and these
      // loops run over every pixel of a full-screen layer — so the colour is
      // only set when the tone actually changes, which neighbours rarely do.
      if (tone !== previous) g.fillStyle = tones[previous = tone];
      g.fillRect(x, y, 1, 1);
    }
  }
}

// Filled circle built from horizontal runs of whole pixels. Given a coverage,
// it instead paints only that fraction of its pixels, chosen by the Bayer
// pattern — stacked between two solid tones, that dissolves the seam.
function disc(cx, cy, r, colour, g = ctx, coverage = 0) {
  g.fillStyle = colour;
  cx = round(cx);
  cy = round(cy);
  const ri = floor(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const half = floor(sqrt(r * r - dy * dy));
    if (coverage) {
      for (let x = cx - half; x <= cx + half; x++) {
        if (dither4(x, cy + dy) < coverage) g.fillRect(x, cy + dy, 1, 1);
      }
    } else {
      g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
    }
  }
}

// ============================================================
// Drawing
// ============================================================

function renderSkyLayer() {
  const [, g] = sized(bW, bH, skyLayer);

  // Tone by ALTITUDE — distance above the planet's surface — so the sky's
  // bands curve with the world rather than lying in flat horizontal stripes.
  // Deep blue up high, pale at the horizon, which is depth 1.
  const pcx = toB(planet.cx);
  const pcy = toB(planet.cy);
  const pr = toB(planet.r);
  const maxAlt = max(1, hypot(pcx, pcy) - pr, hypot(bW - pcx, pcy) - pr);

  ditherFill(g, bW, bH, ['#54b9f6', '#75cdfb', '#93deff', '#b0e9ff', '#c9f1fd', '#dcf6fe'], 0.2,
    (x, y) => 1 - min(1, max(0, hypot(x - pcx, y - pcy) - pr) / maxAlt));
}

function drawSky() {
  ctx.drawImage(skyLayer, 0, 0);
}

function renderSunLayer() {
  // Width cap protects narrow portraits. Counter the 4× landscape camera
  // scale so zooming enlarges the action without also enlarging the sun.
  sunR = round(min(bH * 0.26, bW * 0.18, 40) * PIXEL_SIZE / viewScale);
  const size = sunR * 2 + 1;
  const [, g] = sized(size, size, sunLayer);

  // Five tones from warm rim to white-hot core. Depth is radial, so anything
  // outside the disc reports -1 and stays transparent.
  ditherFill(g, size, size, ['#ffd042', '#ffe164', '#ffef92', '#fff8c6', '#ffffff'], 0.28,
    (x, y) => {
      const d = hypot(x - sunR, y - sunR) / sunR;
      return d > 1 ? -1 : 1 - d;
    });
}

function drawSun(sourceX, sourceY) {
  // Anchor to the visible top-left so the sun keeps the same partial-corner
  // composition at every aspect ratio.
  const sx = sourceX + round(sunR * 0.55);
  const sy = sourceY + round(sunR * 0.35);

  const dirs = SUN_RAYS[sunRay];
  const reach = [1.7, 2.15, 1.5][sunRay];
  for (let n = 0; n < dirs.length; n++) {
    const [dx, dy] = dirs[n];
    const mag = hypot(dx, dy);
    const start = ceil((sunR + 4) / mag);
    const len = round(sunR * reach / mag);
    for (let i = 0; i < len; i++) {
      const x = sx + dx * (start + i);
      const y = sy + dy * (start + i);
      if (i < len * 0.55 || (i + n) % (sunRay === 2 ? 3 : 2) === 0)
        pset(x, y, '#ffe98c');
    }
  }

  ctx.drawImage(sunLayer, sx - sunR, sy - sunR);
}

const CLOUD_DEFS = [
  { fx: 0.15, fy: 0.30, s: 18, wind: 2.4 },
  { fx: 0.45, fy: 0.12, s: 26, wind: 3.4 },
  { fx: 0.70, fy: 0.24, s: 15, wind: 4.4 },
];

// A cloud is four overlapping puffs, painted seven times over. Each tone goes
// down solid, then again one pixel higher as a Bayer half-tone, which
// dissolves the seam with the tone above it instead of leaving a hard step.
// The last two passes are the sunlit highlight, shrunk and nudged up-left.
//   drop, radius scale, highlight shift, colour, dither coverage
const CLOUD_PASSES = [
  [2, 1, 0, '#b9d9f4', 0],
  [2, 1, 0, '#d7ebfc', 0.35],
  [1, 1, 0, '#d7ebfc', 0],
  [1, 1, 0, '#f2f9ff', 0.35],
  [0, 1, 0, '#f2f9ff', 0],
  [0, 0.78, 1, '#ffffff', 0.35],
  [0, 0.6, 1, '#ffffff', 0],
];

function renderCloudLayers() {
  cloudLayers = CLOUD_DEFS.map(def => {
    const s = def.s;
    const [cvs, g] = sized(ceil(s * 3.3) + 8, ceil(s * 2.1) + 8);
    const ox = ceil(s * 1.4) + 4;   // cloud origin within the canvas
    const oy = ceil(s * 1.2) + 4;

    const puffs = [
      [-s * 0.7,  0,        s * 0.55],
      [ 0,       -s * 0.35, s * 0.7 ],
      [ s * 0.7, -s * 0.1,  s * 0.55],
      [ s * 1.3,  s * 0.15, s * 0.4 ],
    ];
    // Every pass repaints all four puffs; only the offset, size, colour and
    // dither change, so the passes are a table rather than seven near-copies.
    for (const [drop, scale, lift, colour, coverage] of CLOUD_PASSES)
      for (const [px, py, pr] of puffs)
        disc(ox + px - lift * pr * 0.25, oy + py + drop - lift * pr * 0.3, pr * scale, colour, g, coverage);

    return { cvs, ox, oy };
  });
}

function drawClouds() {
  const span = bW + 160;
  for (let i = 0; i < CLOUD_DEFS.length; i++) {
    const def = CLOUD_DEFS[i];
    const layer = cloudLayers[i];
    const raw = def.fx * span - t * def.wind - toB(state.distance) * 0.15;
    const x = ((raw % span) + span) % span - 80;
    ctx.drawImage(layer.cvs, round(x) - layer.ox, round(bH * def.fy) - layer.oy);
  }
}

// Rolling hill bands, prerendered as seamlessly-tiling strips (their sine
// waves complete whole cycles across the width) with a 1px sunlit crest
// and a Bayer-dithered fade from crest-light into the body colour
const HILL_DEFS = [
  { base: 0.60, amp: 5,   k1: 3, k2: 8,  phase: 0.7, top: '#d5f5e8', light: '#c4eedd', body: '#b2e6d2', scroll: 0.04 },
  { base: 0.65, amp: 6.5, k1: 5, k2: 13, phase: 2.3, top: '#b6ecd0', light: '#a4e4c2', body: '#8fdbb5', scroll: 0.09 },
];

function renderHillLayers() {
  hillLayers = HILL_DEFS.map(def => {
    const [cvs, g] = sized(max(1, bW), bH);
    const FADE = 20;
    // The crest line first: two sine waves that both complete whole cycles
    // across the strip's width, which is what lets the tile repeat seamlessly
    // as it scrolls. It is measured once per column because the fill below
    // needs it for every row underneath.
    const crest = [];
    for (let x = 0; x < bW; x++) {
      const a = (x / bW) * PI * 2;
      crest[x] = round(bH * def.base + sin(a * def.k1 + def.phase) * def.amp
        + sin(a * def.k2 + def.phase * 2) * def.amp * 0.4);
    }
    // Below the crest, a dithered fade from crest-light into the body colour
    // over FADE rows; past that the depth runs above 1 and clamps, filling the
    // rest of the strip solid. Above the crest is open sky.
    ditherFill(g, bW, bH, [def.light, def.body], 0.25,
      (x, y) => y <= crest[x] ? -1 : (y - crest[x]) / FADE);
    // One sunlit pixel sitting on the crest itself.
    g.fillStyle = def.top;
    for (let x = 0; x < bW; x++) g.fillRect(x, crest[x], 1, 1);
    return { cvs, scroll: def.scroll };
  });
}

function drawFarHills() {
  // Two blits per band, wrapping the tile as it parallax-scrolls
  for (const h of hillLayers) {
    const off = floor(state.distance * h.scroll) % bW;
    ctx.drawImage(h.cvs, -off, 0);
    ctx.drawImage(h.cvs, bW - off, 0);
  }
}

function renderPlanetLayer() {
  const [, g] = sized(bW, bH, planetLayer);

  // Turf as a Bayer-dithered fade from sunlit rim to deep grass — only five
  // tones spread over 48 rows, so each grass band gets real breathing room.
  // Everything below the fade sits past depth 1 and clamps to the deepest
  // tone, which fills the rest of the column; above the ground line is sky.
  const FADE = 48;
  const ground = [];
  for (let x = 0; x < bW; x++) ground[x] = floor(wyB(x));
  ditherFill(g, bW, bH, ['#daf7a6', '#a8e892', '#84d980', '#69cb72', '#5abf68'], 0.25,
    (x, y) => y < ground[x] ? -1 : (y - ground[x]) / (FADE - 1));
}

function drawPlanet() {
  ctx.drawImage(planetLayer, 0, 0);
}

function renderRainbowLayer() {
  // Sized so the arch is enormous: it always exits the right edge of the
  // screen before its far foot comes back down.
  rbBandW = max(4, round(min(bH * 0.03, viewW * 0.06)));
  rbThickness = rbBandW * RAINBOW_COLOURS.length;
  rbRadius = round(max(bH * 0.72, bW * 0.24));

  const lw = max(1, min(bW, rbRadius * 2));
  const lh = max(1, rbRadius);
  const [, g] = sized(lw, lh, rainbowLayer);

  // Arc centre sits at (rbRadius, lh) so the near foot lands at x = 0.
  // Drawn column by column, outermost band first: each band paints from
  // its outer curve down to the baseline and the next band overdraws
  // below its own curve, which leaves clean concentric pixel rings and a
  // solid planted foot.
  for (let x = 0; x < lw; x++) {
    const dx = x - rbRadius;
    const ad = abs(dx);
    for (let i = 0; i < RAINBOW_COLOURS.length; i++) {
      const ro = rbRadius - i * rbBandW;
      const ri = ro - rbBandW;
      if (ad >= ro) continue;
      const yo = lh - floor(sqrt(ro * ro - dx * dx));
      const yi = ad >= ri ? lh : lh - floor(sqrt(ri * ri - dx * dx));
      g.fillStyle = RAINBOW_COLOURS[i];
      g.fillRect(x, yo, 1, max(1, yi - yo));
    }
  }

}

// The ridge flowers and the big foreground ones are the same plant at two
// scales: a stem, a leaf or two, and a four-petalled head that leans with the
// wind. Only their palette, proportions and sway rate differ, so those live
// in this table and the drawing below is written once.
//
//   petal colours, centre, stem, leaf, stem height, head lift,
//   petal spread, sway speed, per-plant sway offset
const BLOOMS = [
  [['#ff9dce', '#a78cff', '#ffd6e8', '#8fd7ff'], '#ffe76d', '#4ca85e', '#65c576', 3, 2, 1, 1.6, 9],
  [['#ff8ac2', '#9678ff', '#ffc2dd', '#6cc4ff'], '#ffe06a', '#3f9c53', '#4fb363', 7, 1, 2, 1.5, 8],
];

function drawBloom(x, y, seed, big) {
  const [petals, centre, stem, leaf, height, lift, spread, speed, wobble] = BLOOMS[big];
  const petal = petals[floor(seed * 4)];
  const sway = round(sin(t * speed + seed * wobble));
  // The small flower's head is single pixels; the big one's petals are the
  // smallest possible disc, which is a five-pixel plus sign.
  const mark = (px, py, colour) => big ? disc(px, py, 1, colour) : pset(px, py, colour);

  rectB(x, y - height, 1, height, stem);
  if (big) {
    pset(x - 1, y - 4, leaf);
    pset(x + 1, y - 3, leaf);
  } else {
    pset(x + (seed > 0.5 ? 1 : -1), y - 2, leaf);
  }

  const fx = x + sway, fy = y - height - lift;
  mark(fx, fy - spread, petal);
  mark(fx, fy + spread, petal);
  mark(fx - spread, fy, petal);
  mark(fx + spread, fy, petal);
  mark(fx, fy, centre);
}
const drawFlower = (x, y, seed) => drawBloom(x, y, seed, 0);
const drawBigFlower = (x, y, seed) => drawBloom(x, y, seed, 1);

// One blade of grass: a vertical stroke whose tip is flicked sideways by the
// wind, plus an optional stray pixel splayed out at its foot. Both grass
// clumps in the game are three of these at different heights.
function blade(x, y, dx, height, tipDx, colour, sway, foot) {
  rectB(x + dx, y - height, 1, height, colour);
  pset(x + tipDx + sway, y - height - 1, colour);
  if (foot !== undefined) pset(x + foot, y - 1, colour);
}

function drawGrassTuft(x, y, seed) {
  const c = seed > 0.5 ? '#5cbf6f' : '#48ab5c';
  const sway = round(sin(t * 2 + seed * 12));
  blade(x, y, -2, 1, -2, c, sway);
  blade(x, y, 0, 3, 0, c, sway);
  blade(x, y, 2, 1, 2, c, sway);
}

function drawBush(x, y, seed) {
  const idx = floor(seed * 3);
  const leaf = ['#76d27b', '#62c781', '#8ad79b'][idx];
  const shade = ['#56b866', '#48ad70', '#68c17e'][idx];
  rectB(x - 5, y, 10, 1, '#4dad5e');
  disc(x - 3, y - 3, 3, shade);
  disc(x + 3, y - 3, 3, shade);
  disc(x, y - 4, 3, shade);
  disc(x - 3, y - 4, 2, leaf);
  disc(x + 3, y - 4, 2, leaf);
  disc(x, y - 5, 3, leaf);
  if (hash(seed * 31) > 0.45) {
    pset(x - 3, y - 5, '#ff91c7');
    pset(x + 2, y - 4, '#ffe477');
  }
}

// Both tree kinds stand on the same trunk: a shadow on the grass, a lit stem
// with a shaded right edge, one branch, and roots flaring at the base. Only
// the branch differs, so its position and length come from the caller.
function drawTrunk(x, y, trunkH, shadowW, branchX, branchY, branchW) {
  rectB(x - (shadowW >> 1), y, shadowW, 1, '#4dad5e');
  rectB(x - 1, y - trunkH, 3, trunkH, '#b98a5e');
  rectB(x + 1, y - trunkH, 1, trunkH, '#9c704e');
  rectB(branchX, branchY, branchW, 1, '#9c704e');
  pset(x - 2, y - 1, '#9c704e');
  pset(x + 2, y - 1, '#9c704e');
}

function drawTree(x, y, seed, palette) {
  const [canopy, shade] = TREE_PALETTES[palette];
  const trunkH = 12 + round(hash(seed * 17) * 5);
  const r = 5 + round(hash(seed * 23) * 2);
  const lean = hash(seed * 29) > 0.5 ? 2 : -2;
  const cy = y - trunkH - r + 2;

  drawTrunk(x, y, trunkH, 9, x + (lean < 0 ? -3 : 1), y - trunkH + 3, 3);

  // Several offset crowns give each tree an irregular candy-cloud silhouette.
  disc(x + lean, cy + 2, r + 1, shade);
  disc(x - lean - 3, cy + 3, r - 1, shade);
  disc(x + lean + 4, cy + 3, r - 2, shade);
  disc(x + lean, cy, r, canopy);
  disc(x - lean - 3, cy + 1, r - 1, canopy);
  disc(x + lean + 4, cy + 1, r - 2, canopy);
  pset(x + lean - 2, cy - r + 2, '#fff4ff');
  pset(x + lean - 1, cy - r + 2, '#fff4ff');
}



// Every scattered lane is laid out the same way: evenly spaced slots, each
// nudged by a seeded jitter so the rhythm doesn't read as a grid, scrolling at
// its own parallax rate and wrapping through a span that runs past both screen
// edges so nothing pops into existence at the margins. `place` is handed the
// wrapped x and the slot index, which is the seed for everything else.
function scatter(spacing, margin, jitter, seedMul, seedAdd, parallax, place) {
  const span = bW + margin * 2;
  const offset = toB(state.distance * parallax);
  const count = ceil(span / spacing);
  for (let i = 0; i < count; i++) {
    const raw = i * spacing + hash(i * seedMul + seedAdd) * jitter - offset;
    place(round(((raw % span) + span) % span - margin), i, count);
  }
}

// Tiny marks move with the surface, filling the field without adding more
// large silhouettes that compete with the unicorn and rainbow.
function drawGroundDetail() {
  scatter(7, 10, 5, 2.9, 60, 1.6, (x, i) => {
    const depth = 5 + floor(hash(i * 5.7 + 63) * 40);
    const y = floor(wyB(x) + depth);
    if (y >= bH) return;
    const c = depth < 17 ? '#8ddd82' : depth < 31 ? '#67c773' : '#50b662';
    pset(x, y, c);
    if (hash(i * 8.3 + 2) > 0.45) pset(x + 1, y, c);
  });
}

function drawScenery() {
  // The ridge is the unicorn's plane. Trees have their own broad rhythm so
  // a random run of tiny plants cannot leave the skyline completely bare.
  let firstPalette = -1, lastPalette = -1, repeats = 0;
  scatter(68, 45, 35, 4.7, 30, 1.6, (x, i, treeCount) => {
    const seed = hash(i * 8.3 + 33);
    // Seeded randomness keeps each tree stable while this guard prevents a
    // third matching colour, including where the scrolling strip wraps.
    let palette = floor(hash(i * 6.1 + 41) * 7);
    while ((palette === lastPalette && repeats === 2)
      || (i === treeCount - 1 && palette === firstPalette)) palette = (palette + 1) % 7;
    if (i === 0) firstPalette = palette;
    repeats = palette === lastPalette ? repeats + 1 : 1;
    lastPalette = palette;
    drawTree(x, floor(wyB(x)) + 1, seed, palette);
  });

  // Tiny communities share the ridge but retain plenty of open path.
  scatter(24, 34, 15, 1, 0, 1.6, (x, i) => {
    const kind = hash(i * 3.7 + 11);
    const seed = hash(i * 7.3 + 5);
    if (kind < 0.3) {
      const amount = 2 + round(seed * 2);
      for (let j = 0; j < amount; j++) {
        const px = x + (j - amount / 2) * 4 + round(hash(i * 13 + j) * 2);
        drawGrassTuft(px, floor(wyB(px)) + 1, hash(i * 17 + j));
      }
    } else if (kind < 0.55) {
      const amount = seed > 0.55 ? 3 : 2;
      for (let j = 0; j < amount; j++) {
        const px = x + (j - 1) * 4;
        drawFlower(px, floor(wyB(px)) + 1, hash(i * 11 + j + 2));
      }
    }
  });
}

// Bushes occupy a separate lane down the slope and scroll between the ridge
// and foreground speeds. This missing middle scale makes the depth readable.
function drawMidground() {
  scatter(48, 40, 22, 1.9, 80, 1.9, (x, i) => {
    const depth = 10 + floor(hash(i * 3.1 + 83) * 20);
    const y = floor(wyB(x) + depth);
    if (y > bH + 7) return;
    const seed = hash(i * 6.7 + 89);
    const kind = hash(i * 4.3 + 87);
    // Bushes take most slots; the rest is a grass-and-flower pairing, which
    // keeps the lane from reading as one repeated silhouette.
    if (kind < 0.7) {
      drawBush(x, y, seed);
      if (seed > 0.62) drawFlower(x + 7, y, seed);
    } else {
      drawGrassTuft(x - 2, y, seed);
      drawFlower(x + 3, y, hash(i * 9.1 + 4));
    }
  });
}

// Drawn BEFORE the planet: the baseline is sunk well below the ground line,
// and the ground painted on top clips the arch, so the rainbow meets the
// hill along the hill's own curve instead of stopping on a flat edge.
function drawRainbowArch() {
  const footCss = rainbowFootCss();
  const foot = round(toB(footCss));
  const gy = floor(toB(worldY(footCss)));
  ctx.drawImage(rainbowLayer, foot, gy + 26 - rainbowLayer.height);
}

// Let the turf break into the lowest edge of the rainbow rather than making
// a perfectly clean cut. This is deliberately only two rows: the foot stays
// solid and readable, but now shares the ground's transition language.
function blendRainbowFoot() {
  const foot = round(toB(rainbowFootCss()));
  for (let x = foot; x < foot + rbThickness; x++) {
    const ground = floor(wyB(x));
    if (dither4(x, ground - 1) < 0.5) pset(x, ground - 1, '#daf7a6');
    if (dither4(x, ground - 2) < 0.18) pset(x, ground - 2, '#daf7a6');
  }
}

function drawJigLimb(points, colour) {
  for (const [x, y] of points)
    for (const [dx, dy] of NEIGHBOURS) pset(x + dx, y + dy, OUTLINE);
  for (const [x, y] of points) pset(x, y, colour);
}

// A jig is compound time: two groups of three, where a march is an even
// 1-2-1-2. One bar per second — hop, land, flick, hop, land, flick — with
// the accent on each hop, which is what gives the step its lilt. How far
// the body leaves the grass on each of the six eighth-notes:
const JIG_HOP = [3, 0, 1, 3, 0, 1];


// Leg poses are offsets from the leprechaun's top-left, and the last three
// points of every pose are its shoe — drawn last, in a darker colour and
// without a halo, because outlining a three-pixel foot fattens it to a blob.
//
// A planted foot stays on the grass, so when the body hops it grows an extra
// shin row to make up the height: index 0 is the grounded pose, index 1 the
// stretched one that hangs from a lifted body.
const PLANT_LEFT = ['4e3f4f3g4g2h3h4h', '4e3f4f3g4g3h4h2i3i4i'];
const PLANT_RIGHT = ['8e8f9f8g9g8h9hah', '8e8f9f8g9g8h9h8i9iai'];

// One bar of the jig, as [left leg, right leg] per eighth-note. The lifted
// poses are half the length of a planted leg — that contrast is what reads as
// "knee up" at thirteen pixels tall. The pot hides his left leg, so the
// pointed toe goes on the right where it can actually be seen.
const JIG_STEPS = [
  ['3e4e2f3f4f', PLANT_RIGHT[0]],          // left knee up
  [PLANT_LEFT[0], PLANT_RIGHT[0]],         // both feet down
  ['4e3f4f2g3g4g', PLANT_RIGHT[1]],        // left flick, body airborne
  [PLANT_LEFT[0], '8e9e8f9faf'],           // right knee up
  [PLANT_LEFT[0], '8e8f9f9gagahbhch'],     // right toe pointed out
  [PLANT_LEFT[1], '8e8f9f8g9gag'],         // right flick, body airborne
];

// Drawn AFTER the planet: the pot sits on the grass under the middle of
// the arch's foot, coins twinkling above it.
function drawRainbowPot() {
  const potX = round(toB(potXCss()));
  const potGy = floor(wyB(potX));

  // The leprechaun stands behind the pot, overlapping its rim by three
  // pixels so the pair reads as a single group rather than adjacent sprites.
  const lepGy = floor(wyB(potX + 10));
  const step = floor(t * 6) % 6;
  const hop = JIG_HOP[step];
  const lepX = potX + 3, lepY = lepGy - 17 - hop;
  // The shadow tightens as he leaves the grass, so the hop reads as height
  // rather than the whole sprite sliding upwards.
  rectB(potX + 6 + (hop >> 1), lepGy, 8 - hop, 1, '#4da05b');

  const legs = JIG_STEPS[step].map(pose => pixels(pose, lepX, lepY));
  // Only the shins are haloed. The shoes are dark enough to hold their own
  // edge against the grass, and outlining a three-pixel foot fattened it
  // into a block — so they go down last, plain, over the shin's outline.
  for (const leg of legs) drawJigLimb(leg.slice(0, -3), '#7a4a2e');
  for (const leg of legs) for (const shoe of leg.slice(-3)) pset(...shoe, '#3b3547');

  // The upper body stays intact — arms included — while the legs dance.
  ctx.drawImage(leprechaunSprite, 0, 0, 13, 15, lepX, lepY, 13, 15);

  drawPot(potX, potGy);
}

// The pot is entirely static, so it is stored as rows rather than as code:
// each entry is [dx, dy, width, height, colour index] relative to (x, b),
// where b is the ground row it rests on. Rows are listed bottom-up, exactly
// as the pot is built, and later rows draw over earlier ones.
const POT_TONES = ['#4da05b', '#2c2735', '#3b3547', '#6b6284', '#524b63', '#c1843c', '#ffd54a', '#ffec8a'];
const POT_ROWS = [
  [-6, 0, 12, 1, 0],    // shadow on the grass
  [-4, -1, 1, 1, 1],    // feet
  [3, -1, 1, 1, 1],
  [-4, -2, 8, 1, 2],    // base
  [-6, -5, 12, 3, 2],   // belly
  [-5, -6, 10, 1, 2],   // shoulder
  [-4, -5, 1, 3, 3],    // sheen down the left side
  [-7, -8, 14, 2, 4],   // rim
  [-3, -11, 6, 1, 5],   // soft amber outline around the gold
  [-5, -10, 10, 1, 5],
  [-6, -9, 12, 1, 5],
  [-5, -9, 10, 1, 6],   // gold heap
  [-3, -10, 6, 1, 6],
  [-2, -10, 1, 1, 7],   // glints
  [1, -10, 1, 1, 7],
  [0, -9, 1, 1, 7],
];

function drawPot(x, b) {
  for (const [dx, dy, w, h, tone] of POT_ROWS) rectB(x + dx, b + dy, w, h, POT_TONES[tone]);
}

function drawCoins() {
  for (const c of coins) {
    const bob = c.settled ? round(sin(t * 3 + c.phase)) : 0; // bobs once landed
    const x = round(toB(c.x));
    const y = round(toB(worldY(c.x) - c.h)) + bob;
    const spin = abs(cos(t * 2.5 + c.phase));
    const w = 2 + round(spin * 3);                      // 2..5 px wide as it spins
    rectB(x - 1, floor(wyB(x)), 3, 1, '#4da05b');       // anchor shadow on the grass
    rectB(x - w / 2, y - 3, w, 6, '#e6a817');
    if (w > 2) rectB(x - w / 2 + 1, y - 2, w - 2, 4, '#ffd54a');
    if (spin > 0.6) pset(x - 1, y - 2, '#ffec8a');
  }
}

/** Draw the leprechaun's tiny boot on a resize-safe arc toward the unicorn. */
function drawBoot() {
  if (phase !== 'THROW') return;
  const progress = min(1, phaseTime / THROW_TIME);
  const fromX = potXCss() + 7 * PIXEL_SIZE;
  const toX = unicornXCss() + 3 * PIXEL_SIZE;
  const x = fromX + (toX - fromX) * progress;
  const fromY = worldY(fromX) - 15 * PIXEL_SIZE;
  const toY = worldY(toX) - 9 * PIXEL_SIZE;
  const y = fromY + (toY - fromY) * progress - sin(progress * PI) * 10 * PIXEL_SIZE;
  ctx.save();
  ctx.translate(round(toB(x)), round(toB(y)));
  ctx.rotate((floor(progress * 8) & 3) * PI / 2);
  ctx.fillStyle = '#7a4a2e';
  ctx.fillRect(0, -3, 2, 3);
  ctx.fillRect(-2, -1, 4, 2);
  ctx.fillRect(-3, 0, 3, 1);
  ctx.fillStyle = '#3b3547';
  ctx.fillRect(-3, 1, 5, 1);
  ctx.restore();
}

// ============================================================
// Building the repeated dialog rows
//
// The upgrade list and the Stubbornness list are each a run of identically
// shaped cards. Only the first of each is written out in index.html; the rest
// are cloned from it here and their words swapped in. That keeps one copy of
// a forty-element row shape in the entry instead of three, and it means the
// markup and this file cannot drift apart — a new upgrade is one row in the
// table above, not a block of hand-copied HTML.
// ============================================================

/** Deep-copy `template`, hand it to `fill`, and add it to the list. */
function cloneCard(list, template, fill) {
  const card = template.cloneNode(true);
  fill(card);
  list.append(card);
  return card;
}

const catchRow = catchButton.closest('.row');
for (const [key, title, effectLabel, description] of UPGRADE_INFO.slice(1)) {
  cloneCard(upgradeList, upgradeList.children[0], card => {
    card.className = `row ${key}`;
    card.querySelector('strong').textContent = title;
    card.querySelector('.desc').textContent = description;
    card.querySelector('.effect').children[0].textContent = `${effectLabel} ·`;
    card.querySelector('[data-up]').dataset.up = key;
  });
}
// Cloning appended the new rows after the Catch row, so move it back to the
// bottom — it is the finale and has to read as the last thing in the list.
upgradeList.append(catchRow);

for (const [key, title, description] of STUBBORN_INFO) {
  cloneCard(stubbornList, stubbornList.children[0], card => {
    card.className = `choice ${key}`;
    card.querySelector('[data-stubborn]').dataset.stubborn = key;
    card.querySelector('strong').textContent = title;
    card.querySelector('.scopy').children[1].textContent = description;
  });
}

const upgradeButtons = [...upgradeList.querySelectorAll('[data-up]')];
const stubbornButtons = [...stubbornList.querySelectorAll('[data-stubborn]')];
const allUpgradesMaxed = () => UPGRADE_INFO.every(([key]) => state[key] >= UPGRADE_MAX[key]);

let upgradeSignature = '';

/** Keep the explicit scroll cue visible until the final upgrade is in view. */
function updateUpgradeMore() {
  upgradeScrollCue.hidden = !upgradeMenu.open || upgradeList.scrollTop + upgradeList.clientHeight >= upgradeList.scrollHeight - 2;
}

function updateUpgradeMenu() {
  const money = floor(state.money);
  const chase = chaseRemaining();
  const signature = `${money},${chase},${state.mane},${state.sparkle},${state.gallop},${storageReady},${phase}`;
  if (signature === upgradeSignature) return;
  upgradeSignature = signature;
  upgradeMoney.textContent = money.toLocaleString();
  upgradeChase.textContent = chase;
  for (let i = 0; i < upgradeButtons.length; i++) {
    const button = upgradeButtons[i];
    const [key, title, effectLabel] = UPGRADE_INFO[i];
    const level = state[key];
    const cost = upgradeCost(key, level);
    const maxed = level >= UPGRADE_MAX[key];
    const off = maxed || state.money < cost || phase !== 'RUNNING';
    const row = button.closest('.row');
    row.classList.toggle('off', off);
    const levels = row.querySelectorAll('.pip');
    for (let j = 0; j < levels.length; j++) levels[j].classList.toggle('lit', j < level);
    row.querySelector('.pips').setAttribute('aria-label', `Level ${level} of ${UPGRADE_MAX[key]}`);
    const [now, next] = upgradeEffect(key, level);
    const effect = row.querySelector('.effect');
    const nextEffect = maxed ? 'MAX' : next;
    effect.querySelector('.now').textContent = now;
    effect.querySelector('.next').textContent = nextEffect;
    effect.setAttribute('aria-label', `${effectLabel}: now ${now}, next ${nextEffect}`);
    const costLabel = row.querySelector('.cost');
    costLabel.hidden = maxed;
    costLabel.querySelector('.costvalue').textContent = `${cost.toLocaleString()} gold`;
    button.textContent = maxed ? 'Maxed' : 'Upgrade';
    button.setAttribute('aria-disabled', off);
    button.setAttribute('aria-label', maxed ? `${title}, maximum level` : `Upgrade ${title} for ${cost} gold`);
  }

  const unlocked = allUpgradesMaxed();
  const prestigeFull = meta.points >= 999 || meta.catches >= 999;
  const catchUnavailable = !unlocked || money < CATCH_PRICE || !storageReady || prestigeFull || phase !== 'RUNNING';
  const catchRow = catchButton.closest('.row');
  catchRow.classList.toggle('off', catchUnavailable);
  catchButton.setAttribute('aria-disabled', catchUnavailable);
  catchButton.textContent = !storageReady || prestigeFull ? 'Unavailable' : unlocked ? 'Catch it' : 'Locked';
  if (!storageReady) catchRequirement.textContent = 'Permanent saving is off.';
  else if (prestigeFull) catchRequirement.textContent = 'Stubbornness has reached its limit.';
  else if (!unlocked) catchRequirement.textContent = 'Max every upgrade to unlock.';
  else if (money < CATCH_PRICE) catchRequirement.textContent = 'One last treasure toll stands in the way.';
  else catchRequirement.textContent = 'The rainbow is finally within reach.';
  catchButton.setAttribute('aria-label', catchUnavailable ? catchRequirement.textContent : `Catch the Rainbow for ${CATCH_PRICE} gold`);
}

/** Refresh the persistent choice cards without generating their fixed structure. */
function updateStubbornMenu() {
  stubbornCatches.textContent = meta.catches;
  for (const button of stubbornButtons) {
    const key = button.dataset.stubborn;
    const level = meta[key];
    const discount = value => `${round((1 - pow(.95, value)) * 100)}%`;
    const current = key === 'value' ? level + 1 : discount(level);
    const next = key === 'value' ? `${level + 2} gold per pickup` : discount(level + 1);
    const row = button.closest('.choice');
    row.querySelector('.now').textContent = current;
    row.querySelector('.next').textContent = next;
    row.querySelector('.lvl').textContent = level;
    button.disabled = level >= 999;
  }
}

function showStubbornness() {
  updateStubbornMenu();
  hud.hidden = true;
  stubbornStatus.textContent = '';
  if (!stubbornMenu.open) stubbornMenu.showModal();
  stubbornBody.scrollTop = 0;
  stubbornButtons.find(button => !button.disabled)?.focus({ preventScroll: true });
}

/** Reset once at the end of the tumble, then require all pending choices. */
function enterChoice() {
  resetRun();
  phase = 'CHOICE';
  phaseTime = 0;
  hudUpgrade.hidden = true;
  showStubbornness();
}

/** Keep a modal in the top layer until its shared exit transition finishes. */
function closeDialog(dialog, done) {
  if (!dialog.open || dialog.classList.contains('shut')) return;
  dialog.classList.add('shut');
  setTimeout(() => {
    dialog.close();
    dialog.classList.remove('shut');
    done?.();
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150);
}

function startCatch() {
  if (phase !== 'RUNNING' || !allUpgradesMaxed() || state.money < CATCH_PRICE || !storageReady || meta.points >= 999 || meta.catches >= 999) return;
  disarmReset();
  const next = { ...meta, points: meta.points + 1, catches: meta.catches + 1 };
  if (!commitMeta(next)) {
    upgradeSignature = '';
    updateUpgradeMenu();
    return;
  }
  state.money -= CATCH_PRICE;
  state.approach = chaseTarget();
  commitGame();
  catchProgress = approachProgress();
  phase = 'CLOSING';
  coins = [];
  sparkles = [];
  hud.hidden = true;
  hudUpgrade.hidden = true;
  closeDialog(upgradeMenu, () => {
    phase = 'THROW';
    phaseTime = 0;
    playSound('whoosh');
  });
}

// ============================================================
// New game
//
// The game drops straight into play, so the only way out of a run is the
// New Game control in the corner. Wiping every save is destructive and the
// button is small and easy to hit by accident, so it arms on the first press
// and only resets on a second one — and disarms itself after a few seconds so
// a stray press can never sit waiting to go off later.
// ============================================================

let resetArmed = 0;

/** Put the button back to its resting label. */
function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = 0;
  gameNew.textContent = '\u21ba';
  gameNew.setAttribute('aria-label', 'Start a new game');
}

gameNew.onclick = () => {
  if (phase !== 'RUNNING') return;
  if (!resetArmed) {
    gameNew.textContent = '!';
    gameNew.setAttribute('aria-label', 'Press again to erase everything and start a new game');
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  if (!commitGame(cleanMeta(), initialRun())) {
    // Keep both the current session and durable record intact when the wipe
    // cannot be saved, and make the failure visible on the control itself.
    gameNew.textContent = '×';
    gameNew.setAttribute('aria-label', 'Could not start a new game because saving is unavailable');
    setTimeout(disarmReset, 4000);
    return;
  }
  try { localStorage.removeItem(LEGACY_SAVE_KEY); } catch {}
  resetRun();
  phase = 'RUNNING';
  last = performance.now();
};

hudUpgrade.onclick = () => {
  if (phase !== 'RUNNING' || upgradeMenu.open) return;
  disarmReset();
  updateUpgradeMenu();
  upgradeScrollCue.hidden = true;
  upgradeList.scrollTop = 0;
  upgradeMenu.showModal();
  requestAnimationFrame(updateUpgradeMore);
  hud.hidden = true;
  hudUpgrade.hidden = true;
  hudUpgrade.setAttribute('aria-expanded', 'true');
  upgradeClose.focus();
};
upgradeClose.onclick = () => closeDialog(upgradeMenu);
gameVolume.onclick = () => {
  muted = !muted;
  audioOut.gain.setValueAtTime(muted ? 0 : 1, audio.currentTime);
  gameVolume.setAttribute('aria-pressed', muted);
  gameVolume.setAttribute('aria-label', muted ? 'Unmute game' : 'Mute game');
};
upgradeMenu.onclick = event => {
  const bounds = upgradeMenu.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(upgradeMenu);
};
upgradeMenu.oncancel = event => {
  event.preventDefault();
  closeDialog(upgradeMenu);
};
upgradeList.onscroll = updateUpgradeMore;
upgradeMore.onclick = () => upgradeList.scrollBy({ top: upgradeList.clientHeight * .7, behavior: 'smooth' });
upgradeMenu.onclose = () => {
  hudUpgrade.setAttribute('aria-expanded', 'false');
  if (phase === 'RUNNING') {
    hud.hidden = false;
    hudUpgrade.hidden = false;
    hudUpgrade.focus();
  }
};
upgradeList.onclick = event => {
  if (event.target.closest('#catch-rainbow')) return startCatch();
  const button = event.target.closest('[data-up]');
  if (!button || phase !== 'RUNNING') return;
  const key = button.dataset.up;
  const cost = upgradeCost(key, state[key]);
  if (state.money < cost || state[key] >= UPGRADE_MAX[key]) return;
  state.money -= cost;
  state[key]++;
  commitGame();
  upgradeSignature = '';
  updateUpgradeMenu();
};

document.addEventListener('click', event => {
  if (!event.target.closest('button')) return;
  startAudio();
  playSound('click');
}, true);

stubbornMenu.oncancel = event => event.preventDefault();
stubbornMenu.onclose = () => {
  if (phase === 'CHOICE' && meta.points) queueMicrotask(showStubbornness);
};
stubbornList.onclick = event => {
  const button = event.target.closest('[data-stubborn]');
  if (!button || choosing || phase !== 'CHOICE' || !meta.points) return;
  const key = button.dataset.stubborn;
  if (!META_KEYS.includes(key) || meta[key] >= 999) return;
  choosing = true;
  const next = { ...meta, points: meta.points - 1, [key]: meta[key] + 1 };
  if (!commitGame(next, initialRun())) {
    stubbornStatus.textContent = 'Could not save that choice. Please try again.';
    choosing = false;
    return;
  }
  updateStubbornMenu();
  choosing = false;
  if (meta.points) return stubbornButtons.find(choice => !choice.disabled)?.focus({ preventScroll: true });
  closeDialog(stubbornMenu, () => {
    phase = 'RUNNING';
    hud.hidden = false;
    hudUpgrade.hidden = false;
    last = performance.now();
    hudUpgrade.focus();
  });
};

function updateHud() {
  const coinText = floor(state.money).toLocaleString();
  if (hudMoney.textContent !== coinText) {
    hudMoney.textContent = coinText;
    hud.setAttribute('aria-label', `${coinText} gold`);
  }
  if (upgradeMenu.open) updateUpgradeMenu();
}

function drawUnicorn() {
  const ux = round(toB(unicornXCss()));
  const gy = floor(wyB(ux));
  const tumble = min(1, phaseTime / TUMBLE_TIME);
  const tumbling = phase === 'TUMBLE';
  // The knockback uses a whole-pixel arc and quarter turns to keep hard edges.
  const bob = tumbling ? round(sin(tumble * PI) * 6) : round(abs(sin(t * 5)) * 2);
  const shadowBob = min(4, bob);
  rectB(ux - 5 + shadowBob, gy, 10 - shadowBob * 2, 1, '#4da05b');

  // The sheet is built from text at startup, so there is never a frame where
  // it is missing — no loading state and no fallback drawing to maintain.
  const frame = floor(animClock) % SPRITE_FRAMES;
  if (tumbling) {
    ctx.save();
    ctx.translate(ux, gy - 9 - bob);
    ctx.rotate((round(tumble * 8) & 3) * PI / 2);
    ctx.drawImage(unicornSheet, frame * SPRITE_CELL, 0, SPRITE_CELL, SPRITE_CELL, -9, -9, SPRITE_CELL, SPRITE_CELL);
    ctx.restore();
  } else {
    ctx.drawImage(
      unicornSheet,
      frame * SPRITE_CELL, 0, SPRITE_CELL, SPRITE_CELL,
      ux - 9, gy - SPRITE_FRAME - bob, SPRITE_CELL, SPRITE_CELL
    );
  }
}

// The nearest lane is low and patchy, framing the bottom of the field rather
// than leaving isolated comb-like blades floating near the action.
function drawForeground() {
  // Shallow landscape crops have no genuine near slope; forcing one in would
  // place dark grass beside the actors, so omit it until there is depth room.
  if (viewY + viewH - wyB(viewX + viewW / 2) < 32) return;
  scatter(62, 60, 40, 1.7, 40, 2.4, (x, i) => {
    // Anchor this nearest lane to the camera's lower edge, not the ridge.
    const y = floor(viewY + viewH - 2 - hash(i * 2.3 + 7) * 13);
    const kind = hash(i * 4.1 + 13);
    const seed = hash(i * 6.7 + 21);
    if (kind < 0.8) {
      drawTallGrass(x - 4, y, seed);
      drawTallGrass(x + 4, y + 1, hash(i * 8.7 + 3));
      if (seed > 0.62) drawTallGrass(x + 11, y, hash(i * 5.3 + 8));
    } else {
      drawTallGrass(x - 6, y + 1, seed);
      drawBigFlower(x, y, seed);
      drawTallGrass(x + 6, y + 1, hash(i * 7.1 + 5));
    }
  });
}

// The nearest lane's grass: a tall centre blade with two shorter, darker ones
// splayed either side, each in its own green so the clump reads as depth
// rather than as one flat comb.
function drawTallGrass(x, y, seed) {
  const sway = round(sin(t * 1.8 + seed * 10));
  blade(x, y, 0, 5 + round(seed * 2), 0, '#2f8749', sway);
  blade(x, y, -2, 3, -3, '#4bb162', sway, -3);
  blade(x, y, 2, 4, 3, '#3aa057', sway, 4);
}

function drawSparkles() {
  for (const s of sparkles) {
    ctx.globalAlpha = max(0, min(1, s.life * 1.6));
    ctx.fillStyle = s.colour;
    const x = round(toB(s.x));
    const y = round(toB(s.y));
    if (s.gold) {
      // Tiny tumbling bars read as loose pieces from the heap, not magic.
      const wide = sin(t * 14 + s.r) > 0;
      ctx.fillRect(x, y, wide ? 2 : 1, wide ? 1 : 2);
      if (s.r > 4) pset(x, y, '#ffec8a');
    } else if (s.r > 6) {
      // Big particles flash as chunky four-point stars with a moving tail.
      ctx.fillRect(x - 2, y, 5, 1);
      ctx.fillRect(x, y - 2, 1, 5);
      ctx.fillRect(x - sign(s.vx), y - sign(s.vy), 1, 1);
      pset(x, y, '#fff');
    } else {
      ctx.fillRect(x, y, s.r > 4 ? 2 : 1, s.r > 4 ? 2 : 1);
    }
  }
  ctx.globalAlpha = 1;
}

function draw() {
  drawSky();
  drawSun(viewX, viewY);
  drawFarHills();
  drawRainbowArch();   // behind the clouds and the ground
  drawClouds();
  drawPlanet();        // clips the arch to the hill's curve
  blendRainbowFoot();
  drawGroundDetail();
  drawScenery();
  drawRainbowPot();
  drawCoins();
  drawUnicorn();
  drawBoot();
  drawMidground();     // lower slope passes in front of the ridge actors
  drawForeground();
  drawSparkles();

  // Blit at an exact integer scale. The final block may overhang the canvas
  // edge by a couple of CSS pixels rather than creating fractional pixels.
  screenCtx.drawImage(
    worldBuffer,
    viewX, viewY, viewW, viewH,
    0, 0, viewW * viewScale, viewH * viewScale
  );
  updateHud();
}

// ============================================================
// Main loop
// ============================================================

function loop(now) {
  const dt = max(0, min(0.033, (now - last) / 1000));
  last = now;
  update(dt);
  scheduleMusic();
  draw();
  requestAnimationFrame(loop);
}

resize();
draw();
addEventListener('resize', resize);
addEventListener('resize', updateUpgradeMore);
// Catches every way the canvas can change size (dev-tools emulation,
// mobile browser bars collapsing, orientation) — not just window resizes
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);
const saveOnExit = () => phase === 'RUNNING' && commitGame();
addEventListener('pagehide', saveOnExit);
document.addEventListener('visibilitychange', () => document.hidden && saveOnExit());

// Play begins at once. The one thing that can stand in front of a run is a
// Stubbornness choice banked by a previous catch, which must be spent before
// the next chase can start.
if (phase === 'CHOICE') {
  showStubbornness();
} else {
  hud.hidden = false;
  hudUpgrade.hidden = false;
  queueMicrotask(() => hudUpgrade.focus());
}
requestAnimationFrame(loop);
})();
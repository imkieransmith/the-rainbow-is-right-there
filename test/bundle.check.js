import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { minifyHtml } from '../scripts/pack.mjs';
import { createGameHarness, SAVE_KEY } from './helpers/game-harness.js';

test('production artifact is fully inlined and contains no test adapter', async () => {
  const html = await readFile('dist/index.html', 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /__gameTest|SOURCE_ADAPTER|test:unicorn/);
  assert.equal([...html.matchAll(/<\/script/gi)].length, 1, 'packed data must not terminate its script early');
});

test('packed bundle writes exactly the minified markup index.html declares', async () => {
  const [source, built] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('dist/index.html', 'utf8'),
  ]);
  // All game markup lives in the packed script; there is no separate loading
  // overlay or unpacked copy left in the artifact.
  assert.doesNotMatch(built, /Loading magic|id=["']?loading|id=["']?upgrade-menu/);

  const harness = await createGameHarness({ source: 'bundle', seed: 91 });
  const compact = minifyHtml(source);
  const expected = compact.slice(compact.indexOf('<div id=game>'), compact.indexOf('</body>'))
    .replace(/<script[^>]*><\/script>/g, '');
  const written = harness.document.written.join('');
  assert.match(written, /^<style>[\s\S]+<\/style>/);
  assert.equal(written.slice(written.indexOf('</style>') + 8), expected);
});

async function scriptedOutcome(source) {
  const saved = JSON.stringify({
    meta: { points: 0, catches: 0, drop: 0, value: 0, chase: 0 },
    run: { money: 1000, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  });
  const harness = await createGameHarness({ source, seed: 91, storage: { [SAVE_KEY]: saved } });
  harness.clearCanvasOperations();
  harness.step(20);
  harness.step(20);
  const openingDraws = harness.operations('screen').filter(operation => operation.type === 'drawImage').length;
  const preSaveWrites = harness.storage.log.filter(entry => entry.type === 'set').length;

  // Buy the first upgrade, close the dialog, then arm and fire New Game.
  harness.event('click', harness.element('hud-upgrade'));
  const upgrade = harness.document.querySelectorAll('[data-up]')[0];
  harness.event('click', upgrade);
  const savedAfterUpgrade = JSON.parse(harness.storage.values.get(SAVE_KEY));
  harness.event('click', harness.element('upgrade-close'));
  harness.settleTimers();
  harness.event('click', harness.element('game-new'));
  const armedLabel = harness.element('game-new').getAttribute('aria-label');
  harness.event('click', harness.element('game-new'));
  harness.step();
  const reset = JSON.parse(harness.storage.values.get(SAVE_KEY));
  return {
    openingDraws,
    preSaveWrites,
    hudUp: !harness.element('hud').hidden,
    armedLabel,
    menuOpen: harness.element('upgrade-menu').open,
    upgraded: savedAfterUpgrade.run[upgrade.dataset.up] > 0,
    resetLevel: reset.run[upgrade.dataset.up],
    money: reset.run.money,
    rafLoops: harness.raf.length,
    errors: harness.errors.map(error => error.message),
  };
}

test('source and minified bundle produce the same scripted black-box outcome', async () => {
  const bundle = await scriptedOutcome('bundle');
  assert.equal(bundle.upgraded, true);
  assert.equal(bundle.money, 0);
  assert.deepEqual(bundle, await scriptedOutcome('source'));
});

test('packager accepts the budget and emits exactly one self-contained index entry', async () => {
  const result = spawnSync(process.execPath, ['scripts/package.js'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Within limit/);
  const archive = unzipSync(new Uint8Array(await readFile('dist/entry.zip')));
  assert.deepEqual(Object.keys(archive), ['index.html']);
  assert.equal(strFromU8(archive['index.html']), await readFile('dist/index.html', 'utf8'));
});

test('minified bundle boots straight into play, draws, saves, and resizes', async () => {
  const harness = await createGameHarness({ source: 'bundle', seed: 91 });
  assert.equal(harness.operations('screen').some(operation => operation.type === 'drawImage'), true);
  assert.equal(harness.raf.length, 1);
  // Sprites come from text, so nothing waits on an image load.
  assert.equal(harness.pendingImages(), 0);
  assert.equal(harness.element('hud').hidden, false);

  for (let i = 0; i < 200; i++) harness.step(20);
  assert.ok(harness.storage.values.has(SAVE_KEY));

  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, true);
  harness.event('click', harness.element('upgrade-close'));
  harness.settleTimers();

  harness.resize(180, 260);
  harness.step();
  assert.equal(harness.element('c').width, 180);
  assert.equal(harness.element('c').height, 260);
  assert.equal(harness.raf.length, 1);
  assert.deepEqual(harness.errors, []);
});

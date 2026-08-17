import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness, LEGACY_SAVE_KEY, SAVE_KEY } from './helpers/game-harness.js';


test('normal-motion dialog close ignores duplicate close requests and restores HUD once', async () => {
  const harness = await createGameHarness({ reducedMotion: false });
  harness.settleTimers(150);
  harness.event('click', harness.element('hud-upgrade'));
  const menu = harness.element('upgrade-menu');
  harness.event('click', harness.element('upgrade-close'));
  harness.event('click', harness.element('upgrade-close'));
  assert.equal(menu.open, true);
  assert.equal(menu.classList.contains('shut'), true);
  assert.equal(harness.timers.length, 1);
  harness.settleTimers(149);
  assert.equal(menu.open, true);
  harness.settleTimers(1);
  assert.equal(menu.open, false);
  assert.equal(harness.element('hud').hidden, false);
  assert.equal(harness.element('hud-upgrade').getAttribute('aria-expanded'), 'false');
});

test('catch cannot be awarded twice during the real dialog-closing delay', async () => {
  const harness = await createGameHarness({ reducedMotion: false });
  harness.settleTimers(150);
  harness.game.configureCatchReady();
  harness.event('click', harness.element('hud-upgrade'));
  const catchButton = harness.element('catch-rainbow');
  const before = harness.game.snapshot();
  harness.event('click', catchButton);
  harness.event('click', catchButton);
  const closing = harness.game.snapshot();
  assert.equal(closing.meta.catches, before.meta.catches + 1);
  assert.equal(closing.phase, 'CLOSING');
  harness.settleTimers(149);
  assert.equal(harness.game.snapshot().phase, 'CLOSING');
  harness.settleTimers(1);
  assert.equal(harness.game.snapshot().phase, 'THROW');
});

test('page lifecycle events during play and mid-cinematic do not duplicate saves', async () => {
  const harness = await createGameHarness({ reducedMotion: false });
  harness.storage.log.length = 0;
  // A live run commits once per lifecycle event, not once per listener.
  harness.windowEvent('pagehide');
  assert.equal(harness.storage.log.filter(entry => entry.type === 'set').length, 1);

  // Mid-catch there is nothing safe to write: the run has already been banked
  // and the cinematic is about to reset it.
  harness.game.configureCatchReady();
  harness.event('click', harness.element('hud-upgrade'));
  harness.event('click', harness.element('catch-rainbow'));
  harness.storage.log.length = 0;
  harness.windowEvent('pagehide');
  assert.equal(harness.storage.log.filter(entry => entry.type === 'set').length, 0);
});

test('rapid New Game presses cannot reset twice or reset without arming', async () => {
  const save = {
    meta: { points: 0, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) }, reducedMotion: false });
  const button = harness.element('game-new');
  harness.storage.log.length = 0;
  // Arm, reset, and then a third press only re-arms; it must not wipe again.
  harness.event('click', button);
  harness.event('click', button);
  harness.event('click', button);
  assert.equal(harness.storage.log.filter(entry => entry.type === 'set').length, 1);
  assert.equal(harness.game.snapshot().resetArmed, true);
  assert.equal(harness.game.snapshot().meta.catches, 0);
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
});

test('legacy saves are read at boot and written forward under the current key', async () => {
  for (const points of [0, 1]) {
    const legacy = { points, catches: 1, drop: 0, value: 0, chase: 0 };
    const harness = await createGameHarness({ storage: { [LEGACY_SAVE_KEY]: JSON.stringify(legacy) } });
    assert.equal(harness.game.snapshot().meta.catches, 1);
    assert.equal(harness.game.snapshot().phase, points ? 'CHOICE' : 'RUNNING');
    // Migration happens on the first ordinary save rather than needing a
    // separate step, so a couple of seconds of play is enough to move it.
    harness.game.setPhase('RUNNING');
    for (let i = 0; i < 200; i++) harness.game.update(0.033);
    assert.equal(JSON.parse(harness.storage.values.get(SAVE_KEY)).meta.catches, 1);
  }
});

test('legacy migration failure still leaves an unsaved but playable run', async () => {
  const legacy = { points: 0, catches: 1, drop: 0, value: 0, chase: 0 };
  const harness = await createGameHarness({ storage: { [LEGACY_SAVE_KEY]: JSON.stringify(legacy) }, failWrites: true });
  for (let i = 0; i < 200; i++) harness.game.update(0.033);
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.equal(harness.game.snapshot().storageReady, false);
  assert.equal(harness.storage.values.has(SAVE_KEY), false);
});

test('a legacy pending choice that cannot be written stays mandatory rather than being lost', async () => {
  const legacy = { points: 1, catches: 1, drop: 0, value: 0, chase: 0 };
  const harness = await createGameHarness({ storage: { [LEGACY_SAVE_KEY]: JSON.stringify(legacy) }, failWrites: true });
  harness.settleTimers(200);
  // The choice dialog holds the player until the point is spent, and a failed
  // write must not silently consume it.
  assert.equal(harness.game.snapshot().phase, 'CHOICE');
  assert.equal(harness.element('stubborn-menu').open, true);
  harness.event('click', harness.document.querySelectorAll('[data-stubborn]')[0]);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.match(harness.element('stubborn-status').textContent, /try again/i);
});

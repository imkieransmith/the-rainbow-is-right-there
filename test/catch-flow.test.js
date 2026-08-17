import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness, SAVE_KEY } from './helpers/game-harness.js';

function start(harness) {
  harness.settleTimers();
}

function advanceUntil(harness, expected, limit = 100) {
  for (let i = 0; i < limit && harness.game.snapshot().phase !== expected; i++) harness.game.update(0.1);
  assert.equal(harness.game.snapshot().phase, expected);
}

test('catch remains locked until prerequisites are satisfied', async () => {
  const harness = await createGameHarness();
  start(harness);
  harness.event('click', harness.element('hud-upgrade'));
  const before = harness.game.snapshot();
  harness.event('click', harness.element('catch-rainbow'));
  const after = harness.game.snapshot();
  assert.equal(after.phase, before.phase);
  assert.equal(after.meta.points, before.meta.points);
  assert.match(harness.element('catch-rainbow').textContent, /Locked|Unavailable/);
});

test('fully upgraded catch remains locked when the final toll cannot be paid', async () => {
  const harness = await createGameHarness();
  start(harness);
  harness.game.configureCatchReady();
  harness.game.patchState({ money: 0 });
  harness.event('click', harness.element('hud-upgrade'));
  harness.game.updateUpgradeMenu();
  const before = harness.game.snapshot();
  harness.event('click', harness.element('catch-rainbow'));
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.equal(harness.game.snapshot().meta.points, before.meta.points);
  assert.match(harness.element('catch-requirement').textContent, /toll/i);
});

test('catch requires durable storage and does not award on write failure', async () => {
  const harness = await createGameHarness({ failWrites: true });
  start(harness);
  harness.game.configureCatchReady();
  harness.event('click', harness.element('hud-upgrade'));
  const before = harness.game.snapshot();
  harness.event('click', harness.element('catch-rainbow'));
  const after = harness.game.snapshot();
  assert.equal(after.meta.points, before.meta.points);
  assert.equal(after.meta.catches, before.meta.catches);
  assert.equal(after.phase, 'RUNNING');
  assert.equal(after.storageReady, false);
});

test('complete catch flow awards once, throws, tumbles, resets, requires a choice, and resumes', async () => {
  const harness = await createGameHarness();
  start(harness);
  harness.game.configureCatchReady();
  harness.game.updateUpgradeMenu();
  harness.event('click', harness.element('hud-upgrade'));
  const before = harness.game.snapshot();
  harness.event('click', harness.element('catch-rainbow'));
  harness.event('click', harness.element('catch-rainbow'));
  const awarded = harness.game.snapshot();
  assert.equal(awarded.meta.points, before.meta.points + 1);
  assert.equal(awarded.meta.catches, before.meta.catches + 1);
  assert.ok(awarded.state.money < before.state.money);
  assert.equal(awarded.phase, 'CLOSING');
  assert.equal(awarded.coins.length, 0);
  assert.equal(awarded.sparkles.length, 0);
  assert.ok(harness.storage.values.has(SAVE_KEY));

  harness.settleTimers();
  assert.equal(harness.game.snapshot().phase, 'THROW');
  advanceUntil(harness, 'TUMBLE');
  advanceUntil(harness, 'CHOICE');
  const choosing = harness.game.snapshot();
  assert.equal(harness.element('stubborn-menu').open, true);
  assert.equal(harness.element('hud-upgrade').hidden, true);
  assert.equal(choosing.state.mane + choosing.state.sparkle + choosing.state.gallop, 0);

  const choice = harness.document.querySelectorAll('[data-stubborn]')[0];
  const selected = choice.dataset.stubborn;
  const beforeChoice = harness.game.snapshot();
  harness.event('click', choice);
  const savedChoice = harness.game.snapshot();
  assert.equal(savedChoice.meta.points, beforeChoice.meta.points - 1);
  assert.equal(savedChoice.meta[selected], beforeChoice.meta[selected] + 1);
  for (const key of harness.game.permanentKeys.filter(key => key !== selected)) assert.equal(savedChoice.meta[key], beforeChoice.meta[key]);
  harness.settleTimers();
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.equal(harness.element('stubborn-menu').open, false);
  assert.equal(harness.element('hud-upgrade').hidden, false);
});

test('multiple pending choices consume exactly one point and remain mandatory until exhausted', async () => {
  const save = {
    meta: { points: 2, catches: 2, drop: 0, value: 0, chase: 0 },
    run: { money: 100, distance: 4, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 1 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  assert.equal(harness.game.snapshot().phase, 'CHOICE');
  assert.equal(harness.element('stubborn-menu').open, true);

  const choice = harness.document.querySelectorAll('[data-stubborn]')[1];
  harness.event('click', choice);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.element('stubborn-menu').open, true);
  harness.event('click', choice);
  assert.equal(harness.game.snapshot().meta.points, 0);
  harness.settleTimers();
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
});

test('prestige cap and unavailable storage prevent catch awards', async () => {
  const cappedSave = {
    meta: { points: 0, catches: 0, drop: 0, value: 0, chase: 0 },
    run: { money: 1000, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(cappedSave) } });
  harness.settleTimers();
  harness.game.configureCatchReady();
  harness.game.capMeta('catches');
  harness.event('click', harness.element('hud-upgrade'));
  harness.game.updateUpgradeMenu();
  const before = harness.game.snapshot();
  harness.event('click', harness.element('catch-rainbow'));
  assert.equal(harness.game.snapshot().meta.catches, before.meta.catches);
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.match(harness.element('catch-rainbow').textContent, /Unavailable/);
});

test('failed permanent-choice writes retain the point and show an error', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) }, failWrites: true });
  harness.settleTimers();
  const choice = harness.document.querySelectorAll('[data-stubborn]')[0];
  harness.event('click', choice);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.game.snapshot().meta[choice.dataset.stubborn], 0);
  assert.match(harness.element('stubborn-status').textContent, /Could not save/);
  assert.equal(harness.element('stubborn-menu').open, true);
});

test('capped permanent choices are disabled and cannot consume points', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  const cappedLevel = harness.game.capMeta('drop');
  harness.game.updateStubbornMenu();
  const capped = harness.document.querySelectorAll('[data-stubborn]')[0];
  assert.equal(capped.disabled, true);
  harness.event('click', capped);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.game.snapshot().meta.drop, cappedLevel);
});

test('an impossible all-capped pending-choice save remains contained rather than entering gameplay', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  for (const key of harness.game.permanentKeys) harness.game.capMeta(key);
  harness.game.updateStubbornMenu();
  const choices = harness.document.querySelectorAll('[data-stubborn]');
  assert.ok(choices.every(choice => choice.disabled));
  for (const choice of choices) harness.event('click', choice);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.game.snapshot().phase, 'CHOICE');
  assert.equal(harness.element('stubborn-menu').open, true);
  assert.equal(harness.element('hud').hidden, true);
});

test('clicks on permanent-choice copy or empty list space are ignored', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  harness.event('click', harness.document.querySelectorAll('.scopy')[0]);
  assert.equal(harness.game.snapshot().meta.points, 1);
  harness.event('click', harness.element('stubborn-list'));
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.element('stubborn-menu').open, true);
});

test('unknown Stubbornness choice keys are rejected without consuming a point', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  const choice = harness.document.querySelectorAll('[data-stubborn]')[0];
  const originalKey = choice.dataset.stubborn;
  choice.dataset.stubborn = 'unknown';
  harness.event('click', choice);
  assert.equal(harness.game.snapshot().meta.points, 1);
  assert.equal(harness.game.snapshot().meta[originalKey], 0);
  assert.equal(harness.element('stubborn-menu').open, true);
});

test('forced close and cancel cannot bypass an unresolved Stubbornness choice', async () => {
  const save = {
    meta: { points: 1, catches: 1, drop: 0, value: 0, chase: 0 },
    run: { money: 10, distance: 0, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 0 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.settleTimers();
  const menu = harness.element('stubborn-menu');
  const cancel = harness.event('cancel', menu);
  assert.equal(cancel.defaultPrevented, true);
  menu.close();
  harness.flushMicrotasks();
  assert.equal(menu.open, true);
  assert.equal(harness.game.snapshot().phase, 'CHOICE');
});

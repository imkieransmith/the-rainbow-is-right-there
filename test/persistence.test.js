import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness, LEGACY_SAVE_KEY, SAVE_KEY } from './helpers/game-harness.js';

const plain = value => JSON.parse(JSON.stringify(value));

test('first visit starts fresh and only writes a save once play is under way', async () => {
  const harness = await createGameHarness();
  // Merely opening the page must not create a record; the first autosave tick
  // of an actual run is what writes one.
  assert.equal(harness.storage.values.has(SAVE_KEY), false);
  assert.equal(harness.game.snapshot().state.mane, 0);
  for (let i = 0; i < 200; i++) harness.game.update(0.033);
  assert.equal(harness.storage.values.has(SAVE_KEY), true);
});

test('invalid current or legacy JSON falls back safely and marks storage unavailable', async () => {
  const current = await createGameHarness({ storage: { [SAVE_KEY]: '{not-json' } });
  assert.equal(current.game.snapshot().storageReady, false);
  assert.equal(current.game.snapshot().meta.catches, 0);

  const legacy = await createGameHarness({ storage: { [LEGACY_SAVE_KEY]: '[broken' } });
  assert.equal(legacy.game.snapshot().storageReady, false);
  assert.equal(legacy.game.snapshot().meta.catches, 0);
});

test('valid JSON with a wrong save shape is treated as no save while continuing to use storage', async () => {
  for (const value of ['null', '[]', '42', '"text"', '{"meta":{}}', '{"run":{}}']) {
    const harness = await createGameHarness({ storage: { [SAVE_KEY]: value } });
    assert.equal(harness.game.snapshot().storageReady, true);
    assert.equal(harness.game.snapshot().meta.catches, 0);
    assert.equal(harness.game.snapshot().state.mane, 0);
  }
});

test('storage read failure or a missing storage API still boots a playable fresh run', async () => {
  for (const [options, storageAfterPlay] of [[{ failReads: true }, true], [{ storageUnavailable: true }, false]]) {
    const harness = await createGameHarness(options);
    assert.equal(harness.game.snapshot().storageReady, false);
    assert.equal(harness.game.snapshot().phase, 'RUNNING');
    for (let i = 0; i < 200; i++) harness.game.update(0.033);
    // A readable-but-unwritable store recovers on the first successful write;
    // a completely absent one never does, and must not throw either way.
    assert.equal(harness.game.snapshot().storageReady, storageAfterPlay);
    assert.deepEqual(harness.errors, []);
  }
});

test('valid current save restores sanitized meta and run without creating transient entities', async () => {
  const save = {
    meta: { points: 0, catches: 3, drop: 1, value: 2, chase: 1 },
    run: { money: 123, distance: 45, approach: 1, mane: 1, sparkle: 1, gallop: 1, coinClock: 0.5 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  const snapshot = harness.game.snapshot();
  assert.deepEqual(plain(snapshot.meta), save.meta);
  assert.deepEqual(plain(snapshot.state), save.run);
  assert.equal(snapshot.coins.length, 0);
  assert.equal(snapshot.sparkles.length, 0);
});

test('legacy prestige migrates into a resumable fresh run and current records shadow legacy', async () => {
  const legacy = { points: 1, catches: 2, drop: 1, value: 0, chase: 0 };
  const migrated = await createGameHarness({ storage: { [LEGACY_SAVE_KEY]: JSON.stringify(legacy) } });
  assert.deepEqual(plain(migrated.game.snapshot().meta), legacy);

  const shadowed = await createGameHarness({ storage: {
    [SAVE_KEY]: JSON.stringify({ broken: true }),
    [LEGACY_SAVE_KEY]: JSON.stringify(legacy),
  } });
  assert.equal(shadowed.game.snapshot().meta.points, 0);
});

test('malformed, fractional, negative, excessive, and non-finite save fields are sanitized', async () => {
  const malformed = {
    meta: { points: -1, catches: 1.5, drop: 1000, value: '4', chase: null },
    run: { money: -4, distance: Infinity, approach: 1e20, mane: -1, sparkle: 1.2, gallop: 999, coinClock: 1000 },
  };
  const fresh = await createGameHarness();
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(malformed, (_key, value) => value === Infinity ? 'Infinity' : value) } });
  const snapshot = harness.game.snapshot();
  assert.deepEqual(plain(snapshot.meta), { points: 0, catches: 0, drop: 0, value: 0, chase: 0 });
  assert.deepEqual(plain(snapshot.state), plain(fresh.game.snapshot().state));
  assert.equal(Object.values(snapshot.state).every(Number.isFinite), true);
});

test('successful writes round-trip one complete record', async () => {
  const harness = await createGameHarness();
  harness.settleTimers();
  harness.game.patchState({ distance: 12, approach: 0 });
  harness.windowEvent('pagehide');
  const stored = JSON.parse(harness.storage.values.get(SAVE_KEY));
  assert.ok(stored.meta && stored.run);

  const restored = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(stored) } });
  assert.deepEqual(plain(restored.game.snapshot().meta), stored.meta);
  assert.deepEqual(plain(restored.game.snapshot().state), stored.run);
});

test('a failed upgrade write keeps the purchase session-only, marks storage unavailable, and leaves the durable record unchanged', async () => {
  const harness = await createGameHarness({ failOnWrite: 2 });
  // Advance just past the first autosave (the clock starts at two seconds) so
  // exactly one write has landed and there is a durable record to protect.
  harness.game.patchState({ money: 1000 });
  for (let i = 0; i < 70; i++) harness.game.update(0.033);
  const durableBefore = harness.storage.values.get(SAVE_KEY);
  harness.event('click', harness.element('hud-upgrade'));
  const upgrade = harness.document.querySelectorAll('[data-up]')[0];
  const levelBefore = harness.game.snapshot().state[upgrade.dataset.up];
  harness.event('click', upgrade);
  assert.equal(harness.game.snapshot().state[upgrade.dataset.up], levelBefore + 1);
  assert.equal(harness.game.snapshot().storageReady, false);
  assert.equal(harness.storage.values.get(SAVE_KEY), durableBefore);
  harness.game.updateUpgradeMenu();
  assert.match(harness.element('catch-rainbow').textContent, /Unavailable/);
});

test('a later catch write failure preserves the already durable prestige point for reload recovery', async () => {
  const harness = await createGameHarness({ failOnWrite: 3 });
  for (let i = 0; i < 70; i++) harness.game.update(0.033);
  harness.game.configureCatchReady();
  harness.event('click', harness.element('hud-upgrade'));
  harness.event('click', harness.element('catch-rainbow'));
  assert.equal(harness.game.snapshot().phase, 'CLOSING');
  assert.equal(harness.game.snapshot().storageReady, false);
  const durable = JSON.parse(harness.storage.values.get(SAVE_KEY));
  assert.ok(durable.meta.points > 0);
  const reloaded = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(durable) } });
  assert.ok(reloaded.game.snapshot().meta.points > 0);
  assert.equal(reloaded.game.snapshot().phase, 'CHOICE');
});

test('legacy-key removal failure after reset is harmless because the new current record shadows it', async () => {
  const existing = {
    meta: { points: 0, catches: 2, drop: 1, value: 0, chase: 0 },
    run: { money: 50, distance: 10, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 1 },
  };
  const harness = await createGameHarness({
    storage: { [SAVE_KEY]: JSON.stringify(existing), [LEGACY_SAVE_KEY]: JSON.stringify(existing.meta) },
    failRemovals: true,
  });
  harness.event('click', harness.element('game-new'));
  harness.event('click', harness.element('game-new'));
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.equal(harness.storage.values.has(LEGACY_SAVE_KEY), true);
  const reloaded = await createGameHarness({ storage: Object.fromEntries(harness.storage.values) });
  assert.equal(reloaded.game.snapshot().meta.catches, 0);
});

test('write failures mark storage unavailable and do not claim destructive reset succeeded', async () => {
  const existing = {
    meta: { points: 0, catches: 2, drop: 1, value: 0, chase: 0 },
    run: { money: 50, distance: 10, approach: 0, mane: 0, sparkle: 0, gallop: 0, coinClock: 1 },
  };
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(existing) }, failWrites: true });
  harness.event('click', harness.element('game-new'));
  harness.event('click', harness.element('game-new'));
  const snapshot = harness.game.snapshot();
  // A failed durable wipe must preserve both the live session and the saved
  // record rather than presenting a reset that will be undone on reload.
  assert.equal(snapshot.storageReady, false);
  assert.equal(snapshot.resetArmed, false);
  assert.equal(snapshot.meta.catches, existing.meta.catches);
  assert.equal(snapshot.state.money, existing.run.money);
  assert.match(harness.element('game-new').getAttribute('aria-label'), /Could not start/);
  assert.deepEqual(JSON.parse(harness.storage.values.get(SAVE_KEY)), existing);
});

test('all persistence operations stay inside exact game namespaces and preserve unrelated data', async () => {
  const unrelatedKey = 'another-game:save';
  const harness = await createGameHarness({ storage: { [unrelatedKey]: 'keep-me' } });
  for (let i = 0; i < 200; i++) harness.game.update(0.033);
  harness.windowEvent('pagehide');
  const touched = harness.storage.log.filter(entry => entry.type !== 'get').map(entry => entry.key).filter(Boolean);
  assert.ok(touched.every(key => key === SAVE_KEY || key === LEGACY_SAVE_KEY));
  assert.equal(harness.storage.log.some(entry => entry.type === 'clear'), false);
  assert.equal(harness.storage.values.get(unrelatedKey), 'keep-me');
});

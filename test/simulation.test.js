import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness, SAVE_KEY } from './helpers/game-harness.js';

function start(harness) {
  harness.settleTimers();
  return harness.game.snapshot();
}

function everyNumberFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every(everyNumberFinite);
}

test('RAF clamps long deltas and keeps all simulation values finite', async () => {
  const harness = await createGameHarness();
  const before = harness.game.snapshot();
  harness.step(60_000);
  const after = harness.game.snapshot();
  assert.ok(after.t > before.t && after.t - before.t < 0.04);
  assert.ok(everyNumberFinite(after));
});

test('travel and chase continue while the upgrade dialog is open', async () => {
  const harness = await createGameHarness();
  start(harness);
  harness.game.patchState({ gallop: 1 });
  const before = harness.game.snapshot();
  harness.step(30);
  const moving = harness.game.snapshot();
  assert.ok(moving.state.distance > before.state.distance);
  assert.ok(moving.state.approach > before.state.approach);

  harness.event('click', harness.element('hud-upgrade'));
  const open = harness.game.snapshot();
  harness.step(30);
  const after = harness.game.snapshot();
  assert.ok(after.state.distance > open.state.distance);
  assert.ok(after.state.approach > open.state.approach);
});

test('choice phase advances ambient time but suppresses every gameplay mutation', async () => {
  const harness = await createGameHarness();
  harness.game.setPhase('CHOICE');
  harness.game.setEntities([], []);
  const before = harness.game.snapshot();
  harness.game.update(0.03);
  const after = harness.game.snapshot();
  assert.ok(after.t > before.t);
  assert.deepEqual(JSON.parse(JSON.stringify(after.state)), JSON.parse(JSON.stringify(before.state)));
  assert.equal(after.coins.length, 0);
  assert.equal(after.sparkles.length, 0);
});

test('travel and chase outcomes remain equivalent across fast, medium, and irregular frame cadences', async () => {
  const run = async cadence => {
    const harness = await createGameHarness();
    start(harness);
    harness.game.patchState({ gallop: 1, coinClock: 60 });
    const before = harness.game.snapshot();
    for (const milliseconds of cadence) harness.step(milliseconds);
    const after = harness.game.snapshot();
    return {
      distance: after.state.distance - before.state.distance,
      approach: after.state.approach - before.state.approach,
      time: after.t - before.t,
    };
  };
  const outcomes = await Promise.all([
    run(Array(100).fill(10)),
    run(Array(40).fill(25)),
    run(Array(10).fill([5, 30, 15, 20, 30]).flat()),
  ]);
  for (const key of ['distance', 'approach', 'time']) {
    const values = outcomes.map(outcome => outcome[key]);
    assert.ok(Math.max(...values) - Math.min(...values) < 0.001, `${key} changed with frame cadence`);
  }
});

test('throw and tumble preserve phase order and comparable completion time across frame cadences', async () => {
  const run = async cadence => {
    const harness = await createGameHarness();
    start(harness);
    harness.game.setPhase('THROW');
    const phases = ['THROW'];
    let wallTime = 0;
    for (let frame = 0; frame < 500 && harness.game.snapshot().phase !== 'CHOICE'; frame++) {
      const milliseconds = cadence[frame % cadence.length];
      wallTime += milliseconds;
      harness.step(milliseconds);
      const phase = harness.game.snapshot().phase;
      if (phases.at(-1) !== phase) phases.push(phase);
    }
    assert.equal(harness.game.snapshot().phase, 'CHOICE');
    return { phases, wallTime };
  };
  const outcomes = await Promise.all([run([10]), run([25]), run([5, 30, 15, 20, 30])]);
  for (const outcome of outcomes) assert.deepEqual(outcome.phases, ['THROW', 'TUMBLE', 'CHOICE']);
  const times = outcomes.map(outcome => outcome.wallTime);
  assert.ok(times.every(time => time >= 2800 && time <= 2850));
  assert.ok(Math.max(...times) - Math.min(...times) <= 50);
});

test('autosave is periodic rather than per-frame and lifecycle checkpoints save active play', async () => {
  const harness = await createGameHarness();
  start(harness);
  harness.storage.log.length = 0;
  for (let i = 0; i < 140; i++) harness.step(16);
  const periodicWrites = harness.storage.log.filter(entry => entry.type === 'set');
  assert.ok(periodicWrites.length >= 1 && periodicWrites.length < 10);

  harness.storage.log.length = 0;
  harness.windowEvent('pagehide');
  assert.equal(harness.storage.log.filter(entry => entry.type === 'set' && entry.key === SAVE_KEY).length, 1);

  harness.storage.log.length = 0;
  harness.document.hidden = true;
  harness.event('visibilitychange', harness.document);
  assert.equal(harness.storage.log.filter(entry => entry.type === 'set' && entry.key === SAVE_KEY).length, 1);
});

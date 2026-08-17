import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

function compactTrace(harness) {
  const snapshot = harness.game.snapshot();
  return {
    phase: snapshot.phase,
    gameStarted: snapshot.gameStarted,
    distance: Number(snapshot.state.distance.toFixed(4)),
    time: Number(snapshot.t.toFixed(4)),
    worldDraws: harness.operations(snapshot ? harness.game.tags().world : '').slice(-40).map(operation => operation.type),
    screenDraws: harness.operations('screen').filter(operation => operation.type === 'drawImage').length,
  };
}

test('source boots, draws once, and maintains one RAF loop', async () => {
  const harness = await createGameHarness();
  assert.ok(harness.game);
  assert.equal(harness.operations('screen').some(operation => operation.type === 'drawImage'), true);
  assert.equal(harness.raf.length, 1);
  assert.equal(harness.step(), 1);
  assert.equal(harness.raf.length, 1);
  assert.deepEqual(harness.errors, []);
});

test('seeded source runs are deterministic and isolated', async () => {
  const run = async () => {
    const harness = await createGameHarness({ seed: 77 });
    harness.clearCanvasOperations();
    harness.step(20);
    harness.step(20);
    return compactTrace(harness);
  };
  assert.deepEqual(await run(), await run());
});

test('events and timers drive a real in-game action', async () => {
  const harness = await createGameHarness();
  assert.equal(harness.element('hud').hidden, false);
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, true);
  harness.event('click', harness.element('upgrade-close'));
  harness.settleTimers();
  assert.equal(harness.element('upgrade-menu').open, false);
  assert.equal(harness.element('hud').hidden, false);
});

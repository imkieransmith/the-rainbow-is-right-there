import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

function start(harness) {
  harness.settleTimers();
}

test('gold follows spawn-to-collection flow and awards a reward', async () => {
  const harness = await createGameHarness({ seed: 5 });
  start(harness);
  const initialMoney = harness.game.snapshot().state.money;
  let sawCoin = false;
  let sawParticle = false;
  let collected = false;
  for (let i = 0; i < 200; i++) {
    harness.game.update(0.033);
    const snapshot = harness.game.snapshot();
    sawCoin ||= snapshot.coins.length > 0;
    sawParticle ||= snapshot.sparkles.length > 0;
    if (snapshot.state.money > initialMoney) { collected = true; break; }
  }
  assert.equal(sawCoin, true);
  assert.equal(sawParticle, true);
  assert.equal(collected, true);
  assert.ok(harness.audio.log.some(entry => entry.type === 'start' && entry.node === 'oscillator'));
});

test('spawned gold launches with finite ballistic state and pot spray', async () => {
  const harness = await createGameHarness({ seed: 9 });
  harness.game.spawnCoin();
  const snapshot = harness.game.snapshot();
  assert.equal(snapshot.coins.length, 1);
  assert.ok(snapshot.coins[0].vx < 0);
  assert.ok(snapshot.coins[0].vh > 0);
  assert.equal(snapshot.coins[0].settled, false);
  assert.ok(snapshot.sparkles.length > 0);
  assert.ok(snapshot.sparkles.every(particle => particle.gold));
  assert.ok(snapshot.coins.concat(snapshot.sparkles).every(entity => Object.values(entity).filter(value => typeof value === 'number').every(Number.isFinite)));
});

test('ballistic coins fall, bounce or settle, scroll, and offscreen coins are removed', async () => {
  const harness = await createGameHarness();
  harness.game.setPhase('RUNNING');
  harness.game.patchState({ coinClock: 60 });
  harness.game.setEntities([
    { x: 220, h: 30, vx: 0, vh: -20, restH: 5, settled: false, phase: 0 },
    { x: -100, h: 5, vx: 0, vh: 0, restH: 5, settled: true, phase: 0 },
  ]);
  const before = harness.game.snapshot().coins[0];
  let bounced = false;
  let previousVelocity = before.vh;
  for (let i = 0; i < 100; i++) {
    harness.game.update(0.01);
    const coin = harness.game.snapshot().coins[0];
    if (coin.vh > 0 && previousVelocity < 0) bounced = true;
    previousVelocity = coin.vh;
    if (coin.settled) break;
  }
  const after = harness.game.snapshot().coins;
  assert.equal(after.length, 1);
  assert.ok(after[0].x < before.x);
  assert.equal(bounced, true);
  assert.equal(after[0].settled, true);
});

test('airborne gold inside the magnetic pull cannot hover just outside pickup range', async () => {
  const harness = await createGameHarness({ width: 180, height: 320 });
  start(harness);
  harness.game.patchState({ mane: 10, sparkle: 10, gallop: 10, approach: 179, coinClock: 60 });
  const { focal, planet } = harness.game.snapshot().geometry;
  const worldY = x => planet.cy - Math.sqrt(Math.max(1, planet.r ** 2 - (x - planet.cx) ** 2));
  const collectX = focal.unicorn + 15;
  const collectY = worldY(focal.unicorn) - 24;
  const initialMoney = harness.game.snapshot().state.money;
  harness.game.setEntities([{
    x: collectX, h: worldY(collectX) - collectY - 30,
    vx: 0, vh: 100, restH: 5, settled: false, phase: 0,
  }]);

  for (let i = 0; i < 600 && harness.game.snapshot().coins.length; i++) harness.game.update(1 / 60);

  const snapshot = harness.game.snapshot();
  assert.equal(snapshot.coins.length, 0);
  assert.ok(snapshot.state.money > initialMoney);
});

test('coin scheduling refuses to add another drop when the entity collection is already over its cap', async () => {
  const harness = await createGameHarness();
  harness.game.setPhase('RUNNING');
  harness.game.patchState({ coinClock: 0 });
  const crowded = Array.from({ length: 100 }, (_, index) => ({
    x: 220 + index / 100, h: 5, vx: 0, vh: 0, restH: 5, settled: true, phase: index,
  }));
  harness.game.setEntities(crowded);
  harness.game.update(0.001);
  assert.equal(harness.game.snapshot().coins.length, crowded.length);
});

test('sparkles move under gravity, fade, clean up, and bursts respect a hard cap', async () => {
  const harness = await createGameHarness();
  harness.game.setPhase('RUNNING');
  harness.game.patchState({ coinClock: 60 });
  harness.game.setEntities([], [{ x: 10, y: 10, vx: 2, vy: -5, life: 0.01, r: 3, colour: '#fff', gold: false }]);
  harness.game.update(0.03);
  assert.equal(harness.game.snapshot().sparkles.length, 0);

  harness.game.burst(0, 0, 10_000, ['#fff']);
  const first = harness.game.snapshot().sparkles.length;
  harness.game.burst(0, 0, 10_000, ['#fff']);
  const second = harness.game.snapshot().sparkles.length;
  assert.ok(first > 0 && first < 10_000);
  assert.equal(second, first);
});

test('long deterministic play keeps entities bounded and eventually cleans transient particles', async () => {
  const harness = await createGameHarness({ seed: 44 });
  start(harness);
  let maxCoins = 0;
  let maxSparkles = 0;
  for (let i = 0; i < 1000; i++) {
    harness.game.update(0.033);
    const snapshot = harness.game.snapshot();
    maxCoins = Math.max(maxCoins, snapshot.coins.length);
    maxSparkles = Math.max(maxSparkles, snapshot.sparkles.length);
  }
  assert.ok(maxCoins < 100);
  assert.ok(maxSparkles < 1000);

  harness.game.patchState({ coinClock: 60 });
  for (let i = 0; i < 100; i++) harness.game.update(0.033);
  assert.equal(harness.game.snapshot().sparkles.length, 0);
});

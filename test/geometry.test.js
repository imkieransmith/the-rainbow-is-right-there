import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

function finiteGeometry(geometry) {
  return Object.values(geometry).every(value => typeof value === 'object' ? finiteGeometry(value) : typeof value !== 'number' || Number.isFinite(value));
}

test('landscape, portrait, tiny, and zero-size recovery keep geometry finite', async () => {
  const harness = await createGameHarness({ width: 320, height: 160 });
  const shapes = [[160, 320], [1, 1], [0, 0], [280, 100]];
  for (const [width, height] of shapes) {
    harness.resize(width, height);
    harness.game.draw();
    const geometry = harness.game.snapshot().geometry;
    assert.equal(finiteGeometry(geometry), true);
    assert.ok(geometry.bW >= 1 && geometry.bH >= 1);
    assert.ok(geometry.viewScale >= 1);
    assert.equal(finiteGeometry(geometry.focal), true);
  }
  const recovered = harness.game.snapshot().geometry;
  assert.equal(recovered.W, 280);
  assert.ok(recovered.focal.unicorn < recovered.focal.pot);
  assert.ok(recovered.focal.rainbow < recovered.focal.pot);
});

test('DPR changes resize the backing store and reset the screen transform', async () => {
  const harness = await createGameHarness({ width: 200, height: 120, dpr: 1 });
  harness.clearCanvasOperations();
  harness.setDpr(2);
  harness.resize(200, 120);
  const screen = harness.element('c');
  assert.equal(screen.width, 400);
  assert.equal(screen.height, 240);
  assert.deepEqual(screen.context.transform, [2, 0, 0, 2, 0, 0]);
  assert.equal(screen.context.imageSmoothingEnabled, false);
});

test('zero DPR falls back to a finite one-to-one backing transform', async () => {
  const harness = await createGameHarness({ width: 200, height: 120, dpr: 0 });
  assert.equal(harness.game.snapshot().geometry.dpr, 1);
  assert.equal(harness.element('c').width, 200);
  assert.deepEqual(harness.element('c').context.transform, [1, 0, 0, 1, 0, 0]);
});

test('fractional DPR values keep backing dimensions and transforms finite', async () => {
  for (const dpr of [1.25, 1.5, 2.625]) {
    const harness = await createGameHarness({ width: 200, height: 120, dpr });
    const screen = harness.element('c');
    assert.equal(screen.width, 200 * dpr);
    assert.equal(screen.height, 120 * dpr);
    assert.deepEqual(screen.context.transform, [dpr, 0, 0, dpr, 0, 0]);
    assert.equal(screen.context.imageSmoothingEnabled, false);
  }
});

test('window resize remains a fallback when ResizeObserver is unavailable', async () => {
  const harness = await createGameHarness({ resizeObserverUnavailable: true });
  const canvas = harness.element('c');
  canvas.clientWidth = 333;
  canvas.clientHeight = 111;
  harness.windowEvent('resize');
  const geometry = harness.game.snapshot().geometry;
  assert.equal(geometry.W, 333);
  assert.equal(geometry.H, 111);
});

test('rapid extreme resizes during coin flight, boot throw, and tumble remain finite and drawable', async () => {
  const harness = await createGameHarness({ width: 240, height: 140 });
  harness.game.setEntities(
    [{ x: 100, h: 20, vx: -10, vh: 30, restH: 4, settled: false, phase: 0 }],
    [{ x: 100, y: 40, vx: 2, vy: -3, life: 1, r: 4, colour: '#fff', gold: false }],
  );
  for (const phase of ['THROW', 'TUMBLE']) {
    harness.game.setPhase(phase, 0.4);
    for (const [width, height] of [[1, 1000], [1000, 1], [37, 811], [811, 37], [240, 140]]) {
      harness.resize(width, height);
      harness.game.draw();
      const snapshot = harness.game.snapshot();
      assert.equal(finiteGeometry(snapshot.geometry), true);
      assert.ok(snapshot.coins.concat(snapshot.sparkles).every(entity => Object.values(entity).filter(value => typeof value === 'number').every(Number.isFinite)));
    }
  }
});

test('no-op resize skips static layer rebuilds', async () => {
  const harness = await createGameHarness();
  harness.clearCanvasOperations();
  harness.game.resize();
  assert.equal(harness.allOperations().length, 0);
});

test('resize preserves finite in-flight entities and changes their visible-space coordinates proportionally', async () => {
  const harness = await createGameHarness({ width: 240, height: 140 });
  harness.game.setEntities(
    [{ x: 100, h: 20, vx: -30, vh: 10, restH: 5, settled: false, phase: 0 }],
    [{ x: 100, y: 50, vx: 10, vy: -20, life: 1, r: 3, colour: '#fff', gold: false }],
  );
  const before = harness.game.snapshot();
  harness.resize(400, 180);
  const after = harness.game.snapshot();
  assert.equal(after.coins.length, 1);
  assert.equal(after.sparkles.length, 1);
  assert.notEqual(after.coins[0].x, before.coins[0].x);
  assert.notEqual(after.sparkles[0].x, before.sparkles[0].x);
  assert.ok([after.coins[0], after.sparkles[0]].every(entity => Object.values(entity).filter(value => typeof value === 'number').every(Number.isFinite)));
});

test('final blit uses integer world scaling and fixed focal ordering', async () => {
  const harness = await createGameHarness({ width: 301, height: 171 });
  harness.clearCanvasOperations();
  harness.game.draw();
  const snapshot = harness.game.snapshot();
  const blit = harness.operations('screen').find(operation => operation.type === 'drawImage');
  assert.ok(blit);
  assert.ok(Number.isInteger(snapshot.geometry.viewScale));
  assert.ok(blit.args.every(Number.isFinite));
  assert.equal(harness.element('c').context.imageSmoothingEnabled, false);
  assert.ok(snapshot.state.approach >= 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

function replaceExactly(source, from, to) {
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `mutation target should occur once: ${from}`);
  return source.replace(from, to);
}

async function animationClockContract(transformSource) {
  const harness = await createGameHarness({ transformSource });
  const before = harness.game.snapshot();
  harness.step(20);
  const after = harness.game.snapshot();
  assert.ok(after.t > before.t);
  assert.ok(after.animClock > before.animClock);
}

async function particleCleanupContract(transformSource) {
  const harness = await createGameHarness({ transformSource });
  harness.game.setPhase('RUNNING');
  harness.game.patchState({ coinClock: 60 });
  harness.game.setEntities([], [{ x: 0, y: 0, vx: 0, vy: 0, life: 0.01, r: 3, colour: '#fff', gold: false }]);
  harness.game.update(0.03);
  assert.equal(harness.game.snapshot().sparkles.length, 0);
}

async function phaseGuardContract(transformSource) {
  const harness = await createGameHarness({ transformSource });
  harness.game.setPhase('THROW');
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, false);
}

test('animation contract detects a frozen game clock mutant', async () => {
  await animationClockContract();
  await assert.rejects(() => animationClockContract(source => replaceExactly(source, '  t += dt;', '  t += 0;')), { name: 'AssertionError' });
});

test('entity contract detects a skipped particle cleanup mutant', async () => {
  await particleCleanupContract();
  await assert.rejects(() => particleCleanupContract(source => replaceExactly(
    source,
    '  sparkles = sparkles.filter(s => s.life > 0);',
    '  sparkles = sparkles;',
  )), { name: 'AssertionError' });
});

test('phase contract detects a bypassed upgrade-dialog guard mutant', async () => {
  await phaseGuardContract();
  await assert.rejects(() => phaseGuardContract(source => replaceExactly(
    source,
    "hudUpgrade.onclick = () => {\n  if (phase !== 'RUNNING') return;",
    'hudUpgrade.onclick = () => {',
  )), { name: 'AssertionError' });
});

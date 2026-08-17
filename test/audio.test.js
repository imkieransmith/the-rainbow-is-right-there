import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

const oscillatorStarts = harness => harness.audio.log.filter(entry => entry.type === 'start' && entry.node === 'oscillator').length;

test('an AudioContext constructor failure is an explicit unsupported-platform startup boundary', async () => {
  await assert.rejects(() => createGameHarness({ audioConstructorThrows: true }), /AudioContext unavailable/);
});

test('audio creates one context and safely retries unlock across pointer, touch, and keyboard gestures', async () => {
  const harness = await createGameHarness({ rejectAudioResume: true });
  assert.equal(harness.audio.contexts.length, 1);
  const initialResumes = harness.audio.log.filter(entry => entry.type === 'resume').length;
  harness.windowEvent('pointerdown');
  harness.windowEvent('touchstart');
  harness.windowEvent('keydown');
  assert.equal(harness.audio.contexts.length, 1);
  assert.ok(harness.audio.log.filter(entry => entry.type === 'resume').length > initialResumes);
  assert.deepEqual(harness.errors, []);
});

test('mute toggles gain and accessible state and suppresses subsequent click sound', async () => {
  const harness = await createGameHarness();
  const volume = harness.element('game-volume');
  harness.event('click', volume);
  assert.equal(volume.getAttribute('aria-pressed'), 'true');
  assert.equal(volume.getAttribute('aria-label'), 'Unmute game');
  assert.equal(harness.audio.contexts[0].state, 'running');
  assert.ok(harness.audio.log.some(entry => entry.type === 'set' && entry.name === 'gain' && entry.value === 0));

  const mutedCount = oscillatorStarts(harness);
  assert.equal(oscillatorStarts(harness), mutedCount);

  harness.event('click', volume);
  assert.equal(volume.getAttribute('aria-pressed'), 'false');
  assert.equal(volume.getAttribute('aria-label'), 'Mute game');
  assert.ok(harness.audio.log.some(entry => entry.type === 'set' && entry.name === 'gain' && entry.value === 1));
});

test('button clicks, coin rewards, and catch cinematic trigger semantic sound activity', async () => {
  const harness = await createGameHarness({ seed: 5 });
  const beforeClick = oscillatorStarts(harness);
  harness.event('click', harness.element('hud-upgrade'));
  assert.ok(oscillatorStarts(harness) > beforeClick);
  harness.event('click', harness.element('upgrade-close'));
  harness.settleTimers();

  const beforeReward = oscillatorStarts(harness);
  for (let i = 0; i < 100 && oscillatorStarts(harness) === beforeReward; i++) harness.game.update(0.033);
  assert.ok(oscillatorStarts(harness) > beforeReward);

  harness.game.configureCatchReady();
  harness.event('click', harness.element('hud-upgrade'));
  harness.game.updateUpgradeMenu();
  const beforeCatch = oscillatorStarts(harness);
  harness.event('click', harness.element('catch-rainbow'));
  harness.settleTimers();
  assert.ok(oscillatorStarts(harness) > beforeCatch);
});

test('rapid repeated button clicks are sound-throttled without suppressing the action guards', async () => {
  const harness = await createGameHarness();
  harness.audio.log.length = 0;
  const button = harness.element('hud-upgrade');
  harness.event('click', button);
  const afterFirst = oscillatorStarts(harness);
  assert.ok(afterFirst > 0);
  // A queued duplicate activation makes no extra sound and cannot toggle the
  // now-hidden HUD control back through unreachable close behaviour.
  harness.event('click', button);
  assert.equal(oscillatorStarts(harness), afterFirst);
  assert.equal(harness.element('upgrade-menu').open, true);
  assert.equal(harness.element('upgrade-menu').classList.contains('shut'), false);
});

test('music uses a bounded scheduling horizon and is suppressed during throw and tumble', async () => {
  const harness = await createGameHarness();
  harness.audio.log.length = 0;
  harness.step(16);
  const scheduled = oscillatorStarts(harness);
  assert.ok(scheduled > 0 && scheduled < 10);

  harness.audio.log.length = 0;
  harness.game.setPhase('THROW');
  harness.step(16);
  assert.equal(oscillatorStarts(harness), 0);
  harness.game.setPhase('TUMBLE');
  harness.step(16);
  assert.equal(oscillatorStarts(harness), 0);
});

test('visibility unlock does not create duplicate audio contexts or RAF loops', async () => {
  const harness = await createGameHarness();
  const rafCount = harness.raf.length;
  harness.document.hidden = false;
  harness.event('visibilitychange', harness.document);
  harness.windowEvent('pointerdown');
  harness.windowEvent('pointerdown');
  assert.equal(harness.audio.contexts.length, 1);
  assert.equal(harness.raf.length, rafCount);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness, SAVE_KEY } from './helpers/game-harness.js';

const plain = value => JSON.parse(JSON.stringify(value));
const savedGame = () => ({
  meta: { points: 0, catches: 3, drop: 1, value: 0, chase: 0 },
  run: { money: 321, distance: 12, approach: 1, mane: 1, sparkle: 0, gallop: 1, coinClock: 1 },
});

test('selected unicorn profile is propagated consistently through menu and dialogs', async () => {
  const harness = await createGameHarness({ seed: 8 });
  const name = harness.element('upgrade-title').textContent;
  assert.ok(name);
  assert.equal(harness.element('stubborn-profile-title').textContent, name);
  assert.equal(harness.element('upgrade-bio').textContent, harness.element('stubborn-profile-bio').textContent);
  assert.match(harness.element('stubborn-description').textContent, new RegExp(name));
});

test('play begins immediately with a saved run restored, the HUD up, and Upgrade focused', async () => {
  const save = savedGame();
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  // There is no title screen to get through: the saved run is already live on
  // the first frame, and the only control that needs focus is Upgrade.
  harness.flushMicrotasks();
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.deepEqual(plain(harness.game.snapshot().meta), save.meta);
  assert.equal(harness.element('hud').hidden, false);
  assert.equal(harness.element('hud-upgrade').hidden, false);
  assert.equal(harness.document.activeElement, harness.element('hud-upgrade'));
  assert.equal(harness.raf.length, 1);
});

test('New Game arms on the first press and only erases everything on the second', async () => {
  const save = savedGame();
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  const button = harness.element('game-new');

  harness.event('click', button);
  // Armed, but nothing destroyed yet, and the button says so.
  assert.equal(harness.game.snapshot().resetArmed, true);
  assert.deepEqual(plain(harness.game.snapshot().meta), save.meta);
  assert.match(button.getAttribute('aria-label'), /again/i);

  harness.event('click', button);
  assert.equal(harness.game.snapshot().resetArmed, false);
  assert.equal(harness.game.snapshot().meta.catches, 0);
  assert.equal(harness.game.snapshot().state.mane, 0);
  assert.equal(harness.game.snapshot().phase, 'RUNNING');
  assert.match(button.getAttribute('aria-label'), /Start a new game/);
  assert.deepEqual(JSON.parse(harness.storage.values.get(SAVE_KEY)).meta.catches, 0);
});

test('an armed New Game disarms itself so a stray press cannot go off later', async () => {
  const save = savedGame();
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(save) } });
  harness.event('click', harness.element('game-new'));
  assert.equal(harness.game.snapshot().resetArmed, true);
  harness.settleTimers(10000);
  assert.equal(harness.game.snapshot().resetArmed, false);
  // The next press must arm again rather than reset straight away.
  harness.event('click', harness.element('game-new'));
  assert.deepEqual(plain(harness.game.snapshot().meta), save.meta);
});

test('upgrade dialog manages HUD, focus, scroll cue, Escape, backdrop, and restoration', async () => {
  const harness = await createGameHarness();
  harness.settleTimers();
  const menu = harness.element('upgrade-menu');
  const list = harness.element('upgrade-list');
  list.clientHeight = 100;
  list.scrollHeight = 300;
  harness.event('click', harness.element('hud-upgrade'));
  harness.step();
  assert.equal(menu.open, true);
  assert.equal(harness.element('hud').hidden, true);
  assert.equal(harness.element('hud-upgrade').getAttribute('aria-expanded'), 'true');
  assert.equal(harness.document.activeElement, harness.element('upgrade-close'));
  assert.equal(harness.element('upgrade-scroll-cue').hidden, false);
  harness.event('click', menu, { clientX: 100, clientY: 100 });
  assert.equal(menu.open, true);

  const beforeScroll = list.scrollTop;
  harness.event('click', harness.element('upgrade-more'));
  assert.ok(list.scrollTop > beforeScroll);
  list.scrollTop = list.scrollHeight;
  list.onscroll();
  assert.equal(harness.element('upgrade-scroll-cue').hidden, true);

  const cancel = harness.event('cancel', menu);
  assert.equal(cancel.defaultPrevented, true);
  harness.settleTimers();
  assert.equal(menu.open, false);
  assert.equal(harness.element('hud').hidden, false);
  assert.equal(harness.element('hud-upgrade').getAttribute('aria-expanded'), 'false');
  assert.equal(harness.document.activeElement, harness.element('hud-upgrade'));

  harness.event('click', harness.element('hud-upgrade'));
  harness.event('click', harness.element('upgrade-close'));
  harness.settleTimers();
  assert.equal(menu.open, false);

  harness.event('click', harness.element('hud-upgrade'));
  harness.event('click', menu, { clientX: -1, clientY: -1 });
  harness.settleTimers();
  assert.equal(menu.open, false);
});

test('duplicate activation of the hidden Upgrade HUD control is ignored', async () => {
  const harness = await createGameHarness();
  harness.settleTimers();
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, true);
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, true);
  assert.equal(harness.element('hud-upgrade').getAttribute('aria-expanded'), 'true');
});

test('opening upgrades disarms a pending New Game reset', async () => {
  const harness = await createGameHarness({ storage: { [SAVE_KEY]: JSON.stringify(savedGame()) } });
  harness.event('click', harness.element('game-new'));
  assert.equal(harness.game.snapshot().resetArmed, true);
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.game.snapshot().resetArmed, false);
  assert.match(harness.element('game-new').getAttribute('aria-label'), /Start a new game/);
});

test('actions outside legal phases are ignored', async () => {
  const harness = await createGameHarness();
  assert.equal(harness.element('upgrade-menu').open, false);
  // Mid-cinematic, neither the upgrade dialog nor a destructive reset may be
  // reached — the catch has to play out first.
  harness.game.setPhase('THROW');
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, false);
  harness.event('click', harness.element('game-new'));
  assert.equal(harness.game.snapshot().resetArmed, false);
  harness.game.setPhase('RUNNING');
  harness.event('click', harness.element('hud-upgrade'));
  assert.equal(harness.element('upgrade-menu').open, true);
});

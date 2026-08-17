import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

function startAndOpenUpgrades(harness) {
  harness.settleTimers();
  harness.event('click', harness.element('hud-upgrade'));
}

async function collectionReward({ sparkle = 0, permanentValue = 0 } = {}) {
  const harness = await createGameHarness({ seed: 17 });
  harness.settleTimers();
  harness.game.patchState({ money: 1000, sparkle, coinClock: 0 });
  harness.game.patchMeta({ value: permanentValue });
  const before = harness.game.snapshot().state.money;
  for (let i = 0; i < 200; i++) {
    harness.game.update(0.033);
    const money = harness.game.snapshot().state.money;
    if (money > before) return money - before;
  }
  throw new Error('Deterministic coin was not collected');
}

test('each ordinary upgrade changes only itself, costs gold, persists, and refreshes UI', async () => {
  for (const selected of ['mane', 'sparkle', 'gallop']) {
    const harness = await createGameHarness();
    startAndOpenUpgrades(harness);
    const button = harness.document.querySelectorAll('[data-up]').find(candidate => candidate.dataset.up === selected);
    harness.game.patchState({ money: 1000 });
    const before = harness.game.snapshot();
    harness.storage.log.length = 0;
    harness.event('click', button);
    const after = harness.game.snapshot();
    assert.equal(after.state[selected], before.state[selected] + 1);
    assert.ok(after.state.money < before.state.money);
    for (const other of harness.game.ordinaryUpgradeKeys.filter(key => key !== selected)) assert.equal(after.state[other], before.state[other]);
    assert.ok(harness.storage.log.some(entry => entry.type === 'set'));
    assert.match(button.getAttribute('aria-label'), /Upgrade|maximum/i);
    assert.match(button.closest('.row').querySelector('.pips').getAttribute('aria-label'), /Level/);
  }
});

test('ordinary purchases are rejected when unaffordable, outside running phase, or maxed', async () => {
  const harness = await createGameHarness();
  startAndOpenUpgrades(harness);
  const button = harness.document.querySelectorAll('[data-up]')[0];
  harness.game.patchState({ money: 0 });
  const poor = harness.game.snapshot().state[button.dataset.up];
  harness.event('click', button);
  assert.equal(harness.game.snapshot().state[button.dataset.up], poor);

  harness.game.patchState({ money: 1e9 });
  harness.game.setPhase('CHOICE');
  harness.event('click', button);
  assert.equal(harness.game.snapshot().state[button.dataset.up], poor);

  harness.game.setPhase('RUNNING');
  for (let guard = 0; guard < 100 && button.textContent !== 'Maxed'; guard++) {
    harness.game.patchState({ money: 1e9 });
    harness.event('click', button);
  }
  const maxed = harness.game.snapshot().state[button.dataset.up];
  assert.equal(button.textContent, 'Maxed');
  harness.event('click', button);
  assert.equal(harness.game.snapshot().state[button.dataset.up], maxed);
});

test('release economy uses the approved zero-gold start, price curves, and permanent multipliers', async () => {
  const harness = await createGameHarness();
  assert.equal(harness.game.snapshot().state.money, 0);
  assert.equal(harness.game.catchPrice, 1000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.game.ordinaryUpgradeKeys.map(key => Array.from({ length: 10 }, (_, level) => harness.game.upgradeCost(key, level))))),
    [
      [12, 13, 15, 17, 19, 21, 24, 27, 30, 34],
      [20, 22, 25, 28, 32, 36, 40, 45, 51, 57],
      [40, 45, 50, 56, 64, 72, 81, 91, 102, 115],
    ]
  );

  const normalInterval = harness.game.coinInterval(0);
  harness.game.patchMeta({ drop: 1 });
  assert.ok(Math.abs(harness.game.coinInterval(0) - normalInterval / 1.2) < 1e-9);

  harness.game.patchState({ gallop: 1, approach: 0, coinClock: 60 });
  harness.game.update(0.03);
  assert.ok(Math.abs(harness.game.snapshot().state.approach - 0.09) < 1e-9);

  harness.game.patchMeta({ chase: 0 });
  const normalCost = harness.game.upgradeCost('mane', 0);
  harness.game.patchMeta({ chase: 1 });
  assert.ok(harness.game.upgradeCost('mane', 0) < normalCost);
  harness.game.updateStubbornMenu();
  const discountRow = harness.document.querySelectorAll('[data-stubborn]').find(button => button.dataset.stubborn === 'chase').closest('.choice');
  assert.equal(discountRow.querySelector('.now').textContent, '5%');
  assert.equal(discountRow.querySelector('.next').textContent, '10%');
});

test('ordinary upgrades preserve their qualitative gameplay roles without pinned balance values', async () => {
  const harness = await createGameHarness();
  const state = harness.game.snapshot().state;
  assert.ok(harness.game.coinInterval(state.mane + 1) <= harness.game.coinInterval(state.mane));

  const targetBefore = harness.game.chaseTarget();
  harness.game.patchState({ gallop: state.gallop + 1 });
  assert.ok(harness.game.chaseTarget() >= targetBefore);

  assert.ok(await collectionReward({ sparkle: 1 }) > await collectionReward({ sparkle: 0 }));
});

test('permanent traits improve only their advertised qualitative effect', async () => {
  const dropHarness = await createGameHarness();
  const level = dropHarness.game.snapshot().meta.drop;
  const beforeDrop = dropHarness.game.coinInterval(dropHarness.game.snapshot().state.mane);
  dropHarness.game.patchMeta({ drop: level + 1 });
  assert.ok(dropHarness.game.coinInterval(dropHarness.game.snapshot().state.mane) <= beforeDrop);

  assert.ok(await collectionReward({ permanentValue: 1 }) > await collectionReward({ permanentValue: 0 }));

  const discountHarness = await createGameHarness();
  const ordinaryCost = discountHarness.game.upgradeCost('gallop', 9);
  discountHarness.game.patchMeta({ chase: 1 });
  assert.ok(discountHarness.game.upgradeCost('gallop', 9) < ordinaryCost);
});

test('upgrade UI communicates current, next, unavailable, and max states without fixed values', async () => {
  const harness = await createGameHarness();
  startAndOpenUpgrades(harness);
  for (const button of harness.document.querySelectorAll('[data-up]')) {
    const row = button.closest('.row');
    const effect = row.querySelector('.effect');
    assert.ok(effect.querySelector('.now').textContent);
    assert.ok(effect.querySelector('.next').textContent);
    assert.match(effect.getAttribute('aria-label'), /now.+next/i);
    assert.ok(button.getAttribute('aria-disabled') !== null);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHarness } from './helpers/game-harness.js';

const fills = operations => operations.filter(operation => operation.type === 'fillRect');
const signature = operations => operations.map(operation => [operation.type, operation.x, operation.y, operation.width, operation.height, operation.source, operation.args]).join('|');

test('sun chooses one of three ray silhouettes on load and remains static', async () => {
  const topologies = [];
  for (const seed of [1, 5, 8]) {
    const harness = await createGameHarness({ seed });
    const samples = [];
    const anchors = [];
    for (const time of [0, 1, 5.1, 10.1]) {
      harness.clearCanvasOperations();
      harness.game.setTime(time);
      harness.game.renderPart('sun');
      const operations = harness.operations(harness.game.tags().world);
      samples.push(signature(fills(operations)));
      anchors.push(operations.find(operation => operation.type === 'drawImage')?.args);
    }
    assert.equal(new Set(samples).size, 1);
    assert.deepEqual(anchors.every(anchor => JSON.stringify(anchor) === JSON.stringify(anchors[0])), true);
    topologies.push(samples[0]);
  }
  assert.equal(new Set(topologies).size, 3);
});

test('unicorn is drawable from the first frame, advances and wraps sprite frames, bobs, and tumbles', async () => {
  const harness = await createGameHarness();
  const world = harness.game.tags().world;
  // The sheet is built from a character map at startup, so it must already be
  // drawing on the very first frame — there is no loading state to wait out.
  const unicorn = harness.game.tags().unicorn;
  assert.ok(unicorn);
  harness.clearCanvasOperations();
  harness.game.renderPart('unicorn');
  assert.ok(harness.operations(world).some(operation => operation.type === 'drawImage' && operation.source === unicorn));

  const sourceFrames = [];
  const destinations = [];
  for (let frame = 0; frame <= 5; frame++) {
    harness.clearCanvasOperations();
    harness.game.setAnimClock(frame);
    harness.game.setTime(frame / 5);
    harness.game.setPhase('RUNNING');
    harness.game.renderPart('unicorn');
    const draw = harness.operations(world).find(operation => operation.type === 'drawImage' && operation.source === unicorn);
    sourceFrames.push(draw.args[0]);
    destinations.push(draw.args[5]);
  }
  assert.equal(new Set(sourceFrames.slice(0, 5)).size, 5);
  assert.equal(sourceFrames[0], sourceFrames[5]);
  assert.ok(new Set(destinations).size > 1);

  harness.clearCanvasOperations();
  harness.game.setPhase('TUMBLE', 0.5);
  harness.game.renderPart('unicorn');
  assert.ok(harness.operations(world).some(operation => operation.type === 'rotate'));
  assert.ok(harness.operations(world).some(operation => operation.type === 'translate'));
});

test('both characters are built from text, so no external image is ever requested', async () => {
  const harness = await createGameHarness();
  // Nothing may reach for an Image: the unicorn and the leprechaun are both
  // painted from character maps, which is what lets the entry ship as a single
  // file with no binary asset in it.
  assert.equal(harness.pendingImages(), 0);
  assert.ok(harness.game.tags().unicorn);
  assert.ok(harness.game.tags().leprechaun);

  for (let i = 0; i < 10; i++) harness.step(20);
  harness.resize(180, 320);
  harness.clearCanvasOperations();
  harness.game.renderPart('unicorn');
  const operations = harness.operations(harness.game.tags().world);
  assert.ok(operations.some(operation => operation.type === 'drawImage' && operation.source === harness.game.tags().unicorn));
  assert.ok(fills(operations).length >= 1);
  assert.deepEqual(harness.errors, []);
});

test('leprechaun performs six distinct repeating jig poses with hop-dependent shadow', async () => {
  const harness = await createGameHarness();
  const world = harness.game.tags().world;
  const poses = [];
  const bodyHeights = [];
  for (let step = 0; step <= 6; step++) {
    harness.clearCanvasOperations();
    harness.game.setTime(step / 6 + 0.001);
    harness.game.renderPart('leprechaun');
    const operations = harness.operations(world);
    poses.push(signature(fills(operations)));
    bodyHeights.push(operations.find(operation => operation.type === 'drawImage' && operation.source === harness.game.tags().leprechaun)?.args.at(-3));
  }
  assert.equal(new Set(poses.slice(0, 6)).size, 6);
  assert.equal(poses[0], poses[6]);
  assert.ok(new Set(bodyHeights.slice(0, 6)).size > 1);
});

test('clouds, hills, and seeded scenery move while static seeds remain deterministic', async () => {
  const harness = await createGameHarness({ seed: 222, width: 240, height: 500 });
  const world = harness.game.tags().world;
  const tracePart = (part, time, distance) => {
    harness.clearCanvasOperations();
    harness.game.setTime(time);
    harness.game.patchState({ distance });
    harness.game.renderPart(part);
    return signature(harness.operations(world));
  };
  assert.notEqual(tracePart('clouds', 0, 0), tracePart('clouds', 1, 0));
  assert.notEqual(tracePart('hills', 0, 0), tracePart('hills', 0, 20));
  const movingLayers = ['ground', 'scenery', 'midground', 'foreground'];
  const layerTraces = movingLayers.map(part => [tracePart(part, 0, 0), tracePart(part, 0, 20)]);
  for (const [before, after] of layerTraces) assert.notEqual(before, after);
  assert.equal(new Set(layerTraces.map(([, after]) => after)).size, movingLayers.length);

  const first = await createGameHarness({ seed: 222 });
  const second = await createGameHarness({ seed: 222 });
  for (const candidate of [first, second]) {
    candidate.clearCanvasOperations();
    candidate.game.patchState({ distance: 37 });
    candidate.game.setTime(1.25);
    candidate.game.renderPart('scenery');
  }
  assert.equal(signature(first.operations(first.game.tags().world)), signature(second.operations(second.game.tags().world)));
});

test('foliage sways without moving the static rainbow layer', async () => {
  const harness = await createGameHarness({ seed: 333 });
  const world = harness.game.tags().world;
  const sample = time => {
    harness.clearCanvasOperations();
    harness.game.setTime(time);
    harness.game.renderPart('scenery');
    harness.game.renderPart('foreground');
    return signature(fills(harness.operations(world)));
  };
  assert.notEqual(sample(0), sample(1));
  const rainbowSize = [harness.document.canvases.find(canvas => canvas.__tag === harness.game.tags().rainbow).width,
    harness.document.canvases.find(canvas => canvas.__tag === harness.game.tags().rainbow).height];
  harness.game.setTime(20);
  assert.deepEqual([harness.document.canvases.find(canvas => canvas.__tag === harness.game.tags().rainbow).width,
    harness.document.canvases.find(canvas => canvas.__tag === harness.game.tags().rainbow).height], rainbowSize);
});

test('coins spin, the gold HUD updates, and particles restore alpha with distinct forms', async () => {
  const harness = await createGameHarness();
  const world = harness.game.tags().world;
  harness.game.setEntities([{ x: 100, h: 10, vx: 0, vh: 0, restH: 10, settled: true, phase: 0 }]);
  const coinSample = time => {
    harness.clearCanvasOperations();
    harness.game.setTime(time);
    harness.game.renderPart('coins');
    return signature(fills(harness.operations(world)));
  };
  assert.notEqual(coinSample(0), coinSample(0.7));

  harness.game.patchState({ money: 12345 });
  harness.game.renderPart('hud');
  assert.equal(harness.element('hud-money').textContent, '12,345');
  assert.equal(harness.element('hud').getAttribute('aria-label'), '12,345 gold');

  harness.game.setEntities([], [
    { x: 20, y: 20, vx: 1, vy: 1, life: 0.5, r: 5, colour: '#ffd54a', gold: true },
    { x: 30, y: 20, vx: -1, vy: -1, life: 0.5, r: 8, colour: '#f0f', gold: false },
    { x: 40, y: 20, vx: 0, vy: 0, life: 0.5, r: 3, colour: '#fff', gold: false },
  ]);
  harness.clearCanvasOperations();
  harness.game.renderPart('sparkles');
  const particleFills = fills(harness.operations(world));
  assert.ok(particleFills.some(operation => operation.width > 2));
  assert.ok(particleFills.some(operation => operation.width === 1 || operation.height === 1));
  assert.equal(harness.document.canvases.find(canvas => canvas.__tag === world).context.globalAlpha, 1);
});

test('boot arcs and rotates before tumble transitions into mandatory choice', async () => {
  const harness = await createGameHarness();
  const world = harness.game.tags().world;
  const positions = [];
  for (const progress of [0.1, 0.5, 0.9]) {
    harness.clearCanvasOperations();
    harness.game.setPhase('THROW', progress);
    harness.game.renderPart('boot');
    const operations = harness.operations(world);
    positions.push(operations.find(operation => operation.type === 'translate'));
    assert.ok(operations.some(operation => operation.type === 'rotate'));
    const bootFills = fills(operations);
    assert.equal(bootFills.length, 4);
    assert.ok(bootFills.every(fill => fill.width <= 5 && fill.height <= 3));
  }
  assert.ok(new Set(positions.map(position => `${position.x},${position.y}`)).size > 1);
  harness.game.setPhase('THROW');
  while (harness.game.snapshot().phase === 'THROW') harness.game.update(0.1);
  assert.equal(harness.game.snapshot().phase, 'TUMBLE');
  while (harness.game.snapshot().phase === 'TUMBLE') harness.game.update(0.1);
  assert.equal(harness.game.snapshot().phase, 'CHOICE');
  assert.equal(harness.element('stubborn-menu').open, true);
});

test('full scene preserves semantic background-to-actor composition order', async () => {
  const harness = await createGameHarness();
  harness.flushImages();
  harness.clearCanvasOperations();
  harness.game.draw();
  const tags = harness.game.tags();
  const sources = harness.operations(tags.world).filter(operation => operation.type === 'drawImage').map(operation => operation.source);
  const position = tag => sources.indexOf(tag);
  assert.ok(position(tags.sun) >= 0);
  assert.ok(position(tags.rainbow) > position(tags.sun));
  assert.ok(position(tags.planet) > position(tags.rainbow));
  assert.ok(position(tags.leprechaun) > position(tags.planet));
  assert.ok(position(tags.unicorn) > position(tags.leprechaun));
});

test('static pixel-art layers prerender bounded non-empty content with smoothing disabled', async () => {
  const harness = await createGameHarness();
  const offscreen = harness.document.canvases.filter(canvas => canvas.__tag !== 'screen' && canvas.__tag !== harness.game.tags().world);
  assert.ok(offscreen.length >= 8);
  assert.ok(offscreen.every(canvas => canvas.width >= 0 && canvas.height >= 0));
  assert.ok(offscreen.filter(canvas => canvas.width && canvas.height).every(canvas => canvas.context.operations.length > 0));
  assert.equal(harness.document.canvases.find(canvas => canvas.__tag === harness.game.tags().world).context.imageSmoothingEnabled, false);

  // At least one prerendered layer must genuinely cover its own area, in
  // several distinct tones. That is what proves a dithered gradient actually
  // ran, rather than the layer being left blank or filled flat — and it holds
  // however the pixels are put down.
  const layers = offscreen.filter(canvas => canvas.width && canvas.height).map(canvas => {
    const fills = canvas.context.operations.filter(operation => operation.type === 'fillRect');
    return {
      painted: fills.reduce((total, fill) => total + Math.abs(fill.width * fill.height), 0),
      area: canvas.width * canvas.height,
      tones: new Set(fills.map(fill => fill.fillStyle)).size,
    };
  });
  assert.ok(layers.some(layer => layer.painted >= layer.area && layer.tones >= 4));
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Promise.all([readFile('index.html', 'utf8'), readFile('src/game.js', 'utf8'), readFile('src/style.css', 'utf8')]);

test('every fixed ID and class queried by game code exists in static HTML', async () => {
  const [html, game] = await files;
  // Element ids reach the game two ways: the whitespace-separated list that
  // feeds getElementById at startup, and the occasional direct query.
  const idList = game.match(/`([^`]+)`\s*\.split\([^)]*\)\.map\(id => document\.getElementById\(id\)\)/);
  const ids = [
    ...(idList ? idList[1].trim().split(/\s+/) : []),
    ...[...game.matchAll(/querySelector(?:All)?\(['"]#([\w-]+)['"]\)/g)].map(match => match[1]),
  ];
  const classes = [...game.matchAll(/querySelector(?:All)?\(['"]\.([\w-]+)['"]\)/g)].map(match => match[1]);
  // Guard against the lookup shape moving and quietly emptying this audit.
  assert.ok(ids.length >= 20, `expected the startup id list to be discoverable, found ${ids.length}`);
  assert.ok(classes.length >= 1, `expected class lookups to be discoverable, found ${classes.length}`);
  for (const id of new Set(ids)) assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing #${id}`);
  for (const className of new Set(classes)) assert.match(html, new RegExp(`\\bclass=["'][^"']*\\b${className}\\b`), `missing .${className}`);
  // Only the first row of each list is declared in the markup; the rest are
  // cloned from it at startup and filled in from the tables in game.js. Check
  // both halves: the template is really there, and every key the game builds
  // rows for still has an entry to build them from.
  assert.match(html, /data-up="mane"/);
  assert.match(html, /data-stubborn="drop"/);
  const tableKeys = [...game.matchAll(/^ {2}\['(\w+)', '/gm)].map(match => match[1]);
  for (const key of ['mane', 'sparkle', 'gallop', 'value', 'chase']) {
    assert.ok(tableKeys.includes(key), `no row table entry for ${key}`);
  }
});

test('dialogs, live regions, controls, and external credit retain accessible relationships', async () => {
  const [html, , css] = await files;
  for (const match of html.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) assert.match(html, new RegExp(`\\bid="${id}"`), `missing ARIA target #${id}`);
  }
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<button(?![^>]*\btype="button")[^>]*>/g);
  assert.match(html, /href="https:\/\/kieransmith\.me\/"[^>]*target="_blank"[^>]*rel="noopener"/);
  assert.match(html, /id="game-volume"[^>]*aria-pressed="false"/);
  assert.match(html, /id="hud-upgrade"[^>]*aria-expanded="false"/);
  assert.match(html, /id="upgrade-money"[^>]*><\/b><small>GOLD<\/small>/);
  assert.doesNotMatch(css, /\.tries\s*\{[^}]*text-align:\s*right/);
  assert.match(css, /\.face\s*\{[^}]*background:\s*#c8bdf5/);
});

test('permanent rows mirror upgrades with a blank pennant and right-side Choose button', async () => {
  const [html, game, css] = await files;
  assert.match(html, /class="flag" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /class="sflag"/);
  assert.match(html, /class="choice drop">\s*<span class="flag"[^>]*>[\s\S]*class="scopy"[\s\S]*<button type="button" data-stubborn="drop">Choose<\/button>/);
  assert.match(html, /Permanent level <b class="lvl"><\/b> · <b class="now"><\/b>/);
  assert.doesNotMatch(html, /stubborn-points|choice-word|permanent choice available/);
  assert.match(css, /\.choice\s*\{[^}]*grid-template-columns:\s*28px minmax\(0,1fr\) 84px[^}]*align-items:\s*center/);
  assert.match(css, /\.scopy small\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.doesNotMatch(game, /card\.querySelector\('path'\)/);
  assert.match(css, /\.flag\s*\{[^}]*width:\s*28px/);
});

test('play HUD joins Gold and Spend Gold in one bottom ribbon', async () => {
  const [html, game, css] = await files;
  assert.match(html, /class="play-controls">\s*<div id="hud"[^>]*>.*id="hud-money".*>GOLD.*id="hud-upgrade"/s);
  assert.doesNotMatch(html, /hud-distance|coin-edge|coin-face|coin-glint/);
  assert.doesNotMatch(game, /hudDistance|coinEdge|coinFace|coinGlint/);
  assert.match(css, /#hud-upgrade, \.buy button, \.choice button\s*\{[^}]*calc\(100% - 14px\)/);
  assert.match(css, /\.play-controls\s*\{[^}]*left:\s*50%[^}]*bottom:\s*15px[^}]*max-width:\s*calc\(100% - 30px\)[^}]*height:\s*44px[^}]*display:\s*flex[^}]*translateX\(-50%\)/);
  assert.match(css, /#hud\s*\{[^}]*padding:\s*0 15px 0 25px[^}]*margin-right:\s*5px[^}]*clip-path:[^}]*10px 50%[^}]*flex-direction:\s*column[^}]*justify-content:\s*center[^}]*background:\s*#d0953f[^}]*font-family:\s*var\(--font\)/);
  assert.match(css, /#hud b\s*\{[^}]*color:\s*#f8efe3/);
  assert.match(css, /#hud small\s*\{[^}]*color:\s*#eed9ba/);
  assert.match(css, /#hud b\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /#hud\[hidden\], #hud-upgrade\[hidden\]\s*\{[^}]*display:\s*none[^}]*opacity:\s*0/);
  assert.match(css, /@starting-style\s*\{\s*#hud:not\(\[hidden\]\), #hud-upgrade:not\(\[hidden\]\)\s*\{\s*opacity:\s*0/);
  assert.match(css, /#hud-upgrade\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1[^}]*background:\s*var\(--pink\)/);
  assert.match(css, /\.ctrl\s*\{[^}]*top:\s*12px[^}]*right:\s*12px[^}]*opacity:\s*\.8/);
  assert.match(css, /\.ctrl:hover, \.ctrl:focus-within\s*\{[^}]*opacity:\s*1/);
});

test('player-facing currency copy consistently calls rewards gold', async () => {
  const [html, game] = await files;
  assert.doesNotMatch(html, /\bcoins?\b/i);
  assert.match(html, /Gold drops every/);
  assert.match(game, /Gold per pickup/);
  assert.match(game, /gold per pickup/);
  assert.match(game, /cost\.toLocaleString\(\)\} gold/);
  assert.match(game, /CATCH_PRICE\} gold/);
});

test('startup contains no loading overlay or fallback guard', async () => {
  const [html, game] = await files;
  assert.doesNotMatch(html, /id="loading"|#loading|Loading magic/);
  assert.doesNotMatch(game, /loadingScreen/);
  assert.ok(html.indexOf('rel="stylesheet"') < html.indexOf('id="game"'));
  assert.ok(html.indexOf('id="game"') < html.indexOf('<script type="module"'));
});

test('storage source is namespaced and never clears shared-origin storage', async () => {
  const [, game] = await files;
  assert.match(game, /js13k2026:kieran:unicorn-rainbow-chase:save:v2/);
  assert.match(game, /js13k2026:kieran:unicorn-rainbow-chase:prestige:v1/);
  assert.doesNotMatch(game, /localStorage\.clear\s*\(/);
});

test('responsive CSS retains desktop, mobile, tiny, and reduced-motion contracts', async () => {
  const [, , css] = await files;
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /@media \(max-width: 280px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /#stubborn-list\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.panel\[open\]/);
  assert.match(css, /#stubborn-menu\[open\]/);
});

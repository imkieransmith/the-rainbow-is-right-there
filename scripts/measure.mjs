import fs from 'node:fs';
import vm from 'node:vm';
import { deflateSize, packPayload, payloadSource } from './pack.mjs';

/**
 * Exact per-subsystem ZIP probe.
 *
 * Usage:
 *   ROADROLLER=-1 npx vite build
 *   node scripts/measure.mjs
 *
 * Each row rebuilds a fixed-seed Roadroller payload and measures its complete
 * HTML with Zopfli. The probe defaults to one level-1 search so it remains
 * practical; release numbers can differ slightly because `npm run build` uses
 * three level-2 searches. An expected edit that no longer matches is an error,
 * never a misleading successful `(no match)` result.
 */

const html = fs.readFileSync('dist/index.html', 'utf8');
const scriptOpen = html.lastIndexOf('<script>');
const scriptClose = html.lastIndexOf('</script>');
if (scriptOpen < 0 || scriptClose < scriptOpen) throw new Error('Could not find the packed script in dist/index.html');

const prefix = html.slice(0, scriptOpen + 8);
const payload = html.slice(scriptOpen + 8, scriptClose);
const suffix = html.slice(scriptClose);
const call = 'document.write(';
const callStart = payload.indexOf(call);
if (callStart < 0) throw new Error('Build with ROADROLLER=-1 so the document.write payload is readable');

// Find the end of the first JS string literal without assuming which quote or
// escape sequences the payload helper uses.
const literalStart = callStart + call.length;
const delimiter = payload[literalStart];
if (!['\'', '"', '`'].includes(delimiter)) throw new Error('document.write does not begin with a string literal');
let escaped = false;
let literalEnd = -1;
for (let i = literalStart + 1; i < payload.length; i++) {
  const character = payload[i];
  if (escaped) escaped = false;
  else if (character === '\\') escaped = true;
  else if (character === delimiter) {
    literalEnd = i;
    break;
  }
}
if (literalEnd < 0) throw new Error('Unterminated document.write string literal');

const written = vm.runInNewContext(payload.slice(literalStart, literalEnd + 1));
const styleEnd = written.indexOf('</style>');
if (!written.startsWith('<style>') || styleEnd < 0) throw new Error('Packed payload does not begin with a stylesheet');
const baseParts = {
  css: written.slice(7, styleEnd),
  markup: written.slice(styleEnd + 8),
  js: payload.slice(literalEnd + 2).replace(/^;/, ''),
};
if (payloadSource(baseParts.css, baseParts.markup, baseParts.js) !== payload) {
  throw new Error('Payload parser did not round-trip dist/index.html exactly');
}

const level = Number(process.env.MEASURE_ROADROLLER ?? 1);
const attempts = Number(process.env.MEASURE_ROADROLLER_TRIES ?? 1);
const zipOverhead = 118;

async function measure(parts) {
  const render = code => prefix + code + suffix;
  const packed = await packPayload(parts.css, parts.markup, parts.js, {
    level,
    attempts,
    score: code => deflateSize(render(code), 100),
  });
  return {
    raw: payloadSource(parts.css, parts.markup, parts.js).length,
    packed: packed.code.length,
    zip: packed.score + zipOverhead,
  };
}

const baseline = await measure(baseParts);
console.log(`entry ${baseline.raw} raw -> ${baseline.packed} packed -> ${baseline.zip} ZIP bytes\n`);

const replaceRequired = (text, pattern, replacement, label) => {
  const changed = text.replace(pattern, replacement);
  if (changed === text) throw new Error(`${label}: expected content did not match`);
  return changed;
};
const removeBetween = (text, from, to, label) => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`${label}: expected boundaries did not match`);
  return text.slice(0, start) + text.slice(end);
};

async function cost(label, edit) {
  const parts = { ...baseParts };
  edit(parts);
  if (parts.css === baseParts.css && parts.markup === baseParts.markup && parts.js === baseParts.js) {
    throw new Error(`${label}: edit changed nothing`);
  }
  const result = await measure(parts);
  const raw = String(baseline.raw - result.raw).padStart(6);
  const zip = String(baseline.zip - result.zip).padStart(5);
  console.log(`${label.padEnd(34)} raw -${raw}   ZIP -${zip}`);
}

await cost('all game code', parts => { parts.js = ''; });
await cost('all CSS', parts => { parts.css = ''; });
await cost('all markup', parts => { parts.markup = ''; });
await cost('upgrade dialog markup', parts => {
  parts.markup = removeBetween(parts.markup, '<dialog id=upgrade-menu', '<dialog id=stubborn-menu', 'upgrade dialog markup');
});
await cost('stubbornness dialog markup', parts => {
  parts.markup = removeBetween(parts.markup, '<dialog id=stubborn-menu', '</main>', 'stubbornness dialog markup');
});
await cost('HUD markup', parts => {
  parts.markup = removeBetween(parts.markup, '<div id=hud role=status', '<div class=ctrl>', 'HUD markup');
});
await cost('pip marks (retain support)', parts => {
  parts.markup = replaceRequired(parts.markup, /<i class=pip aria-hidden=true><\/i>/g, '', 'pip marks');
});
await cost('unicorn sprite (character map)', parts => {
  parts.js = replaceRequired(parts.js, /\["\.{40,}"[\s\S]*?\]/, '[]', 'unicorn sprite');
});

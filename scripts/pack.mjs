import { deflateAsync } from '@gfx/zopfli';
import { Packer } from 'roadroller';

/** Remove formatting whitespace and quotes that HTML does not require. */
export function minifyHtml(html) {
  return html
    .replace(/\s*\n\s*/g, '')
    .replace(/="([^"'`=<>\s]+)"/g, '=$1');
}

/** Wrap text as the single-quoted literal used by the packed payload. */
export function quote(text) {
  return `'${text.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

export const payloadSource = (css, markup, js) =>
  `document.write(${quote(`<style>${css}</style>${markup}`)});${js}`;

/** Return the exact raw-DEFLATE size used inside the final ZIP. */
export async function deflateSize(text, iterations = 250) {
  return (await deflateAsync(Buffer.from(text), { numiterations: iterations })).length;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

async function makeCandidate(payload, level, attempt) {
  // Roadroller's optimiser uses Math.random. Fixed per-attempt seeds retain
  // several independent searches while making identical builds reproducible.
  const originalRandom = Math.random;
  Math.random = seededRandom(0x6d2b79f5 ^ attempt * 0x9e3779b9);
  try {
    const packer = new Packer([{ data: payload, type: 'js', action: 'eval' }], {});
    await packer.optimize(level);
    const { firstLine, secondLine } = packer.makeDecoder();
    return firstLine + secondLine;
  } finally {
    Math.random = originalRandom;
  }
}

/**
 * Pack one payload and retain the candidate that is cheapest by `score`.
 * The release build scores complete HTML after DEFLATE, not Roadroller's raw
 * character count, because equal-length decoders can ZIP differently.
 */
export async function packPayload(css, markup, js, {
  level = 2,
  attempts = 3,
  score = code => code.length,
} = {}) {
  const payload = payloadSource(css, markup, js);
  if (level < 0) return { code: payload, score: await score(payload) };
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('ROADROLLER_TRIES must be a positive integer');

  let best;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const code = await makeCandidate(payload, level, attempt);
    const candidate = { code, score: await score(code) };
    if (!best || candidate.score < best.score || candidate.score === best.score && code.length < best.code.length) best = candidate;
  }
  return best;
}

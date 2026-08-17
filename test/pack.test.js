import assert from 'node:assert/strict';
import test from 'node:test';
import { minifyHtml, payloadSource, quote } from '../scripts/pack.mjs';

test('HTML minification only unquotes values legal in unquoted attributes', () => {
  const source = `<p id="safe" data-space="two words" data-empty="" data-equals="a=b" data-left="a<b" data-right="a>b" data-single="a'b" data-tick="a\`b"></p>`;
  const compact = minifyHtml(source);
  assert.match(compact, /id=safe/);
  for (const attribute of ['space', 'empty', 'equals', 'left', 'right', 'single', 'tick']) {
    assert.match(compact, new RegExp(`data-${attribute}="`));
  }
});

test('payload quoting round-trips apostrophes, slashes and line endings', () => {
  const text = "a\\b'c\nd\re";
  assert.equal(Function(`return ${quote(text)}`)(), text);
  assert.equal(payloadSource('', '', 'x()'), "document.write('<style></style>');x()");
});

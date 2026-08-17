import { defineConfig } from 'vite';
import { deflateSize, minifyHtml, packPayload } from './scripts/pack.mjs';

// js13k ships a zip, not a web server, so every separate file costs twice:
// once for the zip entry's own headers and filename, and again because each
// file is deflated as its own stream and cannot reuse the others' dictionary.
// Folding the CSS and JS back into index.html leaves a single entry that
// compresses as one continuous block.
//
// Roadroller context-models the minified stylesheet, markup and game code as
// one self-extracting script. `ROADROLLER=-1` leaves that payload readable for
// scripts/measure.mjs; release builds run three fixed-seed level-2 searches.
// Fixed seeds make identical builds reproducible, and each candidate is judged
// by the complete HTML's final DEFLATE size rather than raw decoder length.
const OPTIMIZE_LEVEL = Number(process.env.ROADROLLER ?? 2);
const ATTEMPTS = OPTIMIZE_LEVEL > 0 ? Number(process.env.ROADROLLER_TRIES ?? 3) : 1;

function inlineEverything() {
  return {
    name: 'inline-everything',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(f => f.fileName.endsWith('.html'));
      if (!html) return;
      let source = html.source;
      let css = '';
      let js = '';

      // Pull the emitted chunk and stylesheet out of the bundle and drop the
      // tags that referenced them; both are about to be re-emitted as one
      // packed script instead.
      for (const file of Object.values(bundle)) {
        if (file === html) continue;
        const name = file.fileName;
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let pattern;

        if (name.endsWith('.js')) {
          js = file.code;
          pattern = new RegExp(`<script[^>]*src="[^"]*${escapedName}"[^>]*></script>`);
        } else if (name.endsWith('.css')) {
          // esbuild keeps the space after the colon in a custom property, but
          // leading whitespace is never part of the value, so it can go.
          css = file.source.trim().replace(/(--[\w-]+):\s+/g, '$1:');
          pattern = new RegExp(`<link[^>]*href="[^"]*${escapedName}"[^>]*>`);
        } else {
          continue;
        }

        const stripped = source.replace(pattern, '');
        if (stripped === source) this.error(`Could not inline emitted file: ${name}`);
        source = stripped;
        delete bundle[name];
      }

      // Formatting whitespace and safely removable attribute quotes cost
      // bytes but carry no document meaning.
      source = minifyHtml(source);

      // Lift the game's markup into the same packed payload as CSS and JS.
      const bodyStart = source.indexOf('<div id=game>');
      const bodyEnd = source.indexOf('</body>');
      if (bodyStart < 0 || bodyEnd < 0) this.error('Could not find the game markup to pack');
      const markup = source.slice(bodyStart, bodyEnd);

      // The packed payload is a classic script at the end of <body>, where
      // document.write appends the unpacked style and markup. HTML's optional
      // structural tags are omitted from the final artifact.
      const render = packed => (source.slice(0, bodyStart) + `<script>${packed}</script>` + source.slice(bodyEnd))
        .replace(/<\/?(?:head|body)>|<\/html>/g, '');
      const packed = await packPayload(css, markup, js, {
        level: OPTIMIZE_LEVEL,
        attempts: ATTEMPTS,
        score: async code => deflateSize(render(code)),
      });
      html.source = render(packed.code);
    },
  };
}

export default defineConfig({
  plugins: [inlineEverything()],
  build: {
    // The entry is opened in whatever the judges are running today, so there
    // is no reason to spend bytes on syntax downlevelling or legacy helpers.
    target: 'esnext',
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    reportCompressedSize: false,
    // Slower than the default esbuild pass, but it folds constants harder and
    // mangles the module's top-level names, which esbuild leaves alone.
    minify: 'terser',
    terserOptions: {
      // `unsafe` lets Terser assume the standard built-ins behave normally —
      // that Math.pow really is exponentiation, that .toString() on a number
      // is not overridden. Those assumptions hold here and save a few dozen
      // bytes once the packer has squeezed everything else.
      //
      // `booleans_as_integers` is deliberately NOT enabled: several booleans
      // here are written straight into ARIA attributes, and aria-disabled="0"
      // is not a value assistive technology understands.
      compress: { passes: 3, drop_console: true, unsafe: true, unsafe_arrows: true, unsafe_math: true },
      mangle: { toplevel: true },
      format: { comments: false },
    },
  },
});

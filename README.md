# The Rainbow Is Right There: An Epic Tale of Galloping

This is a short incremental game for [JS13K 2026](https://js13kgames.com/2026/). The theme is **Unicorns and Rainbows**.

Gallop. Collect gold. Become more fabulous. Then gallop harder. Sparkle brighter. Get closer. You’re going to catch that rainbow. It’s right there.

## Requirements

- Node.js 20.19 or later
- npm

The game only needs a current browser. The game does not need a network connection.

## Development

Run these commands from a clean checkout:

```sh
npm ci
npm run dev
```

Vite prints the local development URL. Use these files as the main source files:

- [`index.html`](index.html)
- [`src/game.js`](src/game.js)
- [`src/style.css`](src/style.css)

## Build

Create the release files with this command:

```sh
npm run build
```

The command creates these files:

- `dist/index.html` is the playable page.
- `dist/entry.zip` is the submission archive.

The packaging step reports the archive size and its difference from the 13,312-byte limit.

The audited release archive is 13,308 bytes, four bytes below the limit.

```text
SHA-256  fd3d71b8c855e54a88a615403cdb0cbc7700650ef647f2c972d55bfb179d73af
```

Roadroller runs three searches with fixed seeds. The build measures the compressed size of each complete HTML result. It then keeps the smallest result.

## Tests

Run the test commands:

```sh
npm test
npm run test:coverage
npm run test:bundle
```

The tests use the Node.js test runner and local test fakes. They check game behavior, progress, storage, audio, layout geometry, accessibility, packaging, and source-to-bundle equivalence.

The release tests cover all tracked functions and V8 branch ranges in `src/game.js`. The game does not include test code.

The tests do not use browser automation or screenshots. Manual tests cover graphics, sound, touch controls, and device performance in Chrome and Firefox.

## Size measurement

Run this optional measurement build:

```sh
ROADROLLER=-1 npx vite build
node scripts/measure.mjs
```

This build shows the compressed cost of selected game parts. The measurement build is not the release build. Run `npm run build` again when the measurement is complete.

## Size methods

- Vite and Terser bundle and minify the source.
- Roadroller puts the CSS, HTML, and JavaScript in one unpacking script.
- Zopfli compresses the final HTML.
- A small ZIP writer creates one top-level `index.html` file.
- The build removes unnecessary HTML spaces and attribute quotes.
- The game clones repeated interface rows from small templates.
- The game generates its pixel art from code and character maps.
- The Web Audio API generates the music and sound effects.
- Fixed build seeds make release builds repeatable.

## Project files

```text
index.html               Document and interface templates
src/game.js              Game logic, graphics, audio, and storage
src/style.css            Interface and dialog styles
scripts/pack.mjs         Roadroller payload builder
scripts/package.js       Zopfli compressor and ZIP writer
scripts/measure.mjs      Optional size measurements
scripts/test-coverage.js V8 coverage report
test/                    Source and release tests
vite.config.js           Build and single-file packaging settings
```

## Resources

The release archive contains one HTML file. The game does not load external code, images, fonts, sound, analytics, or data.

The game draws most artwork from project source code. The unicorn movement frames are based on [Pixel Art Unicorn by RCXNO](https://rcxno.itch.io/pixel-art-unicorn). The game does not include the original image file, instead the game stores a copy of the frames as a character map and creates the sprite sheet in the browser.

The game generates sound in the browser. The interface icons use inline SVG. The text uses system fonts.

## License

Copyright © 2026 Kieran Smith. This project uses the [MIT License](LICENSE).

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { deflateAsync } from '@gfx/zopfli';

// The competition judges only ever see this ZIP, so every byte inside it is
// paid for twice over: once by the file's own bytes and once by whatever the
// compressor cannot squeeze out. Two things therefore matter here.
//
//   1. Use the best deflate encoder we can get. All deflate encoders produce
//      streams any unzip tool can read, but they differ a lot in how hard they
//      search for matches. Zopfli spends seconds instead of milliseconds and
//      typically lands 5-7% below a normal level-9 pass — worth ~1.4 KB here.
//      Zopfli is a required build dependency: silently falling back to a
//      larger encoder would make a release artifact unexpectedly miss budget.
//
//   2. Write the ZIP container by hand. A ZIP wrapping one file needs only
//      118 bytes of headers; general-purpose ZIP writers add extra fields and
//      often ship a weaker deflate. Emitting the three required records
//      ourselves keeps the overhead at the format's true minimum.
const SIZE_LIMIT = 13 * 1024;
const buildDirectory = resolve('dist');
const archivePath = resolve(buildDirectory, 'entry.zip');

/** Compress release bytes without a silent lower-quality fallback. */
async function bestDeflate(bytes) {
  // Returns are almost flat here; 250 iterations gives the release encoder
  // a little more search time without materially slowing packaging.
  return new Uint8Array(await deflateAsync(bytes, { numiterations: 250 }));
}

async function collectFiles(directory) {
  const files = {};
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(path));
    } else if (path !== archivePath) {
      const archiveName = relative(buildDirectory, path).split(sep).join('/');
      files[archiveName] = new Uint8Array(await readFile(path));
    }
  }

  return files;
}

/**
 * Build a minimal ZIP. Each entry contributes a local header before its
 * deflated bytes, plus a central-directory record at the end; the archive
 * closes with a single end-of-central-directory record. Every numeric field
 * is little-endian, and timestamps are pinned to a fixed value so repeated
 * builds of identical input produce byte-identical archives.
 */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, deflated, original] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(original);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract (2.0)
    local.writeUInt16LE(0, 6);            // general purpose flags
    local.writeUInt16LE(8, 8);            // compression method: deflate
    local.writeUInt16LE(0, 10);           // modification time (pinned)
    local.writeUInt16LE(0x21, 12);        // modification date (pinned, 1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);  // central directory header signature
    record.writeUInt16LE(20, 4);          // version made by
    local.copy(record, 6, 4, 30);         // reuse the local header's shared span
    record.writeUInt16LE(0, 32);          // file comment length
    record.writeUInt16LE(0, 34);          // disk number start
    record.writeUInt16LE(0, 36);          // internal attributes
    record.writeUInt32LE(0, 38);          // external attributes
    record.writeUInt32LE(offset, 42);     // offset of the local header

    parts.push(local, nameBytes, deflated);
    central.push(record, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(entries.length, 8);   // entries on this disk
  end.writeUInt16LE(entries.length, 10);  // entries total
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBytes, end]);
}

await rm(archivePath, { force: true });

const files = await collectFiles(buildDirectory);
const entries = [];
for (const [name, bytes] of Object.entries(files)) {
  entries.push([name, await bestDeflate(bytes), bytes]);
}
const archive = buildZip(entries);
await writeFile(archivePath, archive);

const size = archive.byteLength;
const difference = SIZE_LIMIT - size;

console.log(`\nJS13k package: dist/entry.zip`);
console.log(`Compressed size: ${size.toLocaleString()} / ${SIZE_LIMIT.toLocaleString()} bytes`);

if (difference >= 0) {
  console.log(`Within limit: ${difference.toLocaleString()} bytes remaining.`);
} else {
  console.error(`Over the 13 KiB limit by ${Math.abs(difference).toLocaleString()} bytes.`);
  process.exitCode = 1;
}

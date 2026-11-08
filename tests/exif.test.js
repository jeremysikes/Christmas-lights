const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
const exif = LP.require('exif');

/**
 * Build a minimal JPEG: SOI, APP1 "Exif\0\0" + TIFF (IFD0 with Make, Model, Orientation, ExifIFD pointer;
 * ExifIFD with FocalLength rational, FocalLengthIn35mmFilm, DateTimeOriginal), a tiny DQT-like APP0 segment
 * in front (to exercise segment skipping), then SOS/EOI.
 */
function buildJpeg({ le = true, make = 'Apple', model = 'iPhone 15', orientation = 6, focalNum = 596, focalDen = 100,
  focal35 = 26, dateTime = '2026:11:08 17:00:00', includeExifIfd = true } = {}) {
  const tiff = [];
  const u16 = (v) => (le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff]);
  const u32 = (v) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
    : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const ascii = (s) => Array.from(Buffer.from(s + '\0', 'latin1'));

  // Layout (offsets relative to TIFF start):
  // 0: header (8 bytes); 8: IFD0 (2 + n*12 + 4); then data area; then ExifIFD; then its data.
  const ifd0Count = includeExifIfd ? 4 : 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const makeB = ascii(make), modelB = ascii(model);
  let dataOff = 8 + ifd0Size;
  const makeOff = dataOff; dataOff += makeB.length;
  const modelOff = dataOff; dataOff += modelB.length;
  const exifIfdOff = dataOff;
  const exifCount = 3;
  const exifIfdSize = 2 + exifCount * 12 + 4;
  const focalOff = exifIfdOff + exifIfdSize;
  const dtB = ascii(dateTime);
  const dtOff = focalOff + 8;

  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  // IFD0 (entries must be sorted by tag)
  tiff.push(...u16(ifd0Count));
  const entry = (tag, type, count, valueBytes) => tiff.push(...u16(tag), ...u16(type), ...u32(count), ...valueBytes);
  entry(0x010f, 2, makeB.length, makeB.length <= 4 ? makeB.concat([0, 0, 0, 0]).slice(0, 4) : u32(makeOff));
  entry(0x0110, 2, modelB.length, u32(modelOff));
  entry(0x0112, 3, 1, u16(orientation).concat([0, 0]));
  if (includeExifIfd) entry(0x8769, 4, 1, u32(exifIfdOff));
  tiff.push(...u32(0)); // next IFD
  tiff.push(...makeB, ...modelB);
  // ExifIFD
  tiff.push(...u16(exifCount));
  entry(0x9003, 2, dtB.length, u32(dtOff));
  entry(0x920a, 5, 1, u32(focalOff));
  entry(0xa405, 3, 1, u16(focal35).concat([0, 0]));
  tiff.push(...u32(0));
  tiff.push(...u32(focalNum), ...u32(focalDen));
  tiff.push(...dtB);

  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = payload.length + 2;
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const bytes = [0xff, 0xd8, ...app0, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload,
    0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
  return new Uint8Array(bytes);
}

test('parses little-endian (II) EXIF', () => {
  const bytes = buildJpeg({ le: true });
  const r = exif.parseExif(bytes.buffer);
  assert.ok(r);
  assert.equal(r.make, 'Apple');
  assert.equal(r.model, 'iPhone 15');
  assert.equal(r.orientation, 6);
  assert.equal(r.focal35, 26);
  assert.equal(r.focalMm, 5.96);
  assert.equal(r.dateTime, '2026:11:08 17:00:00');
  assert.equal(r.width, null);
});

test('parses big-endian (MM) EXIF and accepts typed arrays / Buffers', () => {
  const bytes = buildJpeg({ le: false, make: 'Google', model: 'Pixel 9', orientation: 1, focalNum: 690, focalDen: 100, focal35: 25 });
  for (const input of [bytes, bytes.buffer, Buffer.from(bytes), new DataView(bytes.buffer)]) {
    const r = exif.parseExif(input);
    assert.ok(r);
    assert.equal(r.make, 'Google');
    assert.equal(r.model, 'Pixel 9');
    assert.equal(r.orientation, 1);
    assert.equal(r.focal35, 25);
    assert.equal(r.focalMm, 6.9);
  }
});

test('short ASCII value stored inline (<= 4 bytes) is read', () => {
  const r = exif.parseExif(buildJpeg({ make: 'LG' }));
  assert.equal(r.make, 'LG');
});

test('missing ExifIFD gives null focal fields but keeps IFD0 data', () => {
  const r = exif.parseExif(buildJpeg({ includeExifIfd: false }));
  assert.ok(r);
  assert.equal(r.make, 'Apple');
  assert.equal(r.focal35, null);
  assert.equal(r.focalMm, null);
});

test('truncated buffers return null at every cut inside the EXIF block', () => {
  const bytes = buildJpeg();
  // The EXIF segment ends before the SOS marker; any cut before that point must fail cleanly.
  const sos = bytes.length - 8;
  for (let cut = 0; cut < sos; cut++) {
    assert.equal(exif.parseExif(bytes.slice(0, cut).buffer), null, 'cut at ' + cut);
  }
});

test('non-JPEG and garbage input return null and never throw', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  assert.equal(exif.parseExif(png.buffer), null);
  assert.equal(exif.parseExif(null), null);
  assert.equal(exif.parseExif(undefined), null);
  assert.equal(exif.parseExif('not bytes'), null);
  assert.equal(exif.parseExif({}), null);
  assert.equal(exif.parseExif(new ArrayBuffer(0)), null);
  // JPEG without APP1
  assert.equal(exif.parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]).buffer), null);
  // Corrupt TIFF byte order and bad offsets
  const bad = buildJpeg();
  const tiffStart = 2 + 18 + 4 + 6;
  const a = bad.slice(); a[tiffStart] = 0x00; assert.equal(exif.parseExif(a), null);
  const b = bad.slice(); b[tiffStart + 4] = 0xff; b[tiffStart + 5] = 0xff; assert.equal(exif.parseExif(b), null);
  // Random bytes after SOI: never throws
  const rnd = LP.require('geometry').rng(7);
  for (let k = 0; k < 200; k++) {
    const buf = buildJpeg();
    for (let j = 0; j < 6; j++) buf[24 + Math.floor(rnd() * (buf.length - 24))] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => exif.parseExif(buf));
  }
});

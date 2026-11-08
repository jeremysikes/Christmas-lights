/* LightPlan core: exif.
 * Minimal, defensive JPEG EXIF reader: just the fields LightPlan needs to pick a focal length.
 *
 *   JPEG = SOI (FFD8), then segments "FF xx <len16> <payload>". EXIF lives in an APP1 (FFE1) segment whose
 *   payload starts with "Exif\0\0" followed by a TIFF structure:
 *     "II" (little endian) or "MM" (big endian), the magic number 42, then the offset of IFD0.
 *   An IFD is a 16-bit entry count followed by 12-byte entries: tag(2) type(2) count(4) value-or-offset(4).
 *   Values longer than 4 bytes live at the offset (relative to the TIFF header start).
 *   IFD0 holds Make/Model/Orientation/DateTime and a pointer (0x8769) to the Exif sub-IFD, which holds
 *   FocalLength (0x920A, rational), FocalLengthIn35mmFilm (0xA405), DateTimeOriginal (0x9003) and the pixel
 *   dimensions (0xA002 / 0xA003).
 *
 * parseExif(buffer) never throws: anything malformed or truncated returns null. Non-JPEG input returns null.
 * Accepts an ArrayBuffer, a typed array (Uint8Array, Node Buffer) or a DataView.
 */
LP.define('exif', [], function () {
  'use strict';

  const TAG = {
    MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112, DATETIME: 0x0132, EXIF_IFD: 0x8769,
    DATETIME_ORIGINAL: 0x9003, FOCAL_LENGTH: 0x920a, PIXEL_X: 0xa002, PIXEL_Y: 0xa003, FOCAL_35: 0xa405,
  };
  // Byte size of one value for each TIFF field type (1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL,
  // 6 SBYTE, 7 UNDEFINED, 8 SSHORT, 9 SLONG, 10 SRATIONAL, 11 FLOAT, 12 DOUBLE).
  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const MAX_IFD_ENTRIES = 1000; // a real IFD has a few dozen; anything larger is garbage

  /** Thrown internally on any out-of-bounds read; caught by parseExif. */
  function Truncated() {}

  function toView(input) {
    if (!input) return null;
    if (input instanceof DataView) return input;
    if (input instanceof ArrayBuffer) return new DataView(input);
    if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  /** Bounds-checked reader over a DataView. */
  function reader(view) {
    const len = view.byteLength;
    const need = (off, n) => { if (!(off >= 0) || off + n > len) throw new Truncated(); };
    return {
      len,
      u8(off) { need(off, 1); return view.getUint8(off); },
      u16(off, le) { need(off, 2); return view.getUint16(off, le); },
      u32(off, le) { need(off, 4); return view.getUint32(off, le); },
      i32(off, le) { need(off, 4); return view.getInt32(off, le); },
      ascii(off, n) {
        need(off, n);
        let s = '';
        for (let i = 0; i < n; i++) {
          const c = view.getUint8(off + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      },
    };
  }

  /** Find the TIFF header offset inside the first APP1 "Exif\0\0" segment. null when there is none. */
  function findTiffStart(r) {
    if (r.len < 4 || r.u8(0) !== 0xff || r.u8(1) !== 0xd8) return null; // not a JPEG
    let off = 2;
    while (off + 4 <= r.len) {
      if (r.u8(off) !== 0xff) return null; // lost sync: malformed
      let marker = r.u8(off + 1);
      // Fill bytes (FF FF ...) are allowed before a marker.
      while (marker === 0xff) { off++; marker = r.u8(off + 1); }
      // Standalone markers carry no length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before pixels
      const segLen = r.u16(off + 2, false);
      if (segLen < 2) return null;
      if (marker === 0xe1 && segLen >= 8 &&
          r.u8(off + 4) === 0x45 && r.u8(off + 5) === 0x78 && r.u8(off + 6) === 0x69 && r.u8(off + 7) === 0x66 &&
          r.u8(off + 8) === 0 && r.u8(off + 9) === 0) {
        // The segment must actually be present in the buffer.
        if (off + 2 + segLen > r.len) throw new Truncated();
        return { start: off + 10, end: off + 2 + segLen };
      }
      off += 2 + segLen;
    }
    return null;
  }

  /** Read one IFD into {tag: entry}. Entry values are decoded lazily by readValue. */
  function readIfd(r, tiff, ifdOffset, le) {
    const base = tiff.start + ifdOffset;
    if (base + 2 > tiff.end) throw new Truncated();
    const n = r.u16(base, le);
    if (n > MAX_IFD_ENTRIES) throw new Truncated();
    if (base + 2 + n * 12 > tiff.end) throw new Truncated();
    const entries = {};
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12;
      const tag = r.u16(e, le);
      const type = r.u16(e + 2, le);
      const count = r.u32(e + 4, le);
      const size = (TYPE_SIZE[type] || 0) * count;
      if (!size) continue; // unknown type or empty value: skip
      const valueOff = size <= 4 ? e + 8 : tiff.start + r.u32(e + 8, le);
      if (valueOff + size > tiff.end) throw new Truncated();
      entries[tag] = { type, count, valueOff };
    }
    return entries;
  }

  function readValue(r, entry, le) {
    if (!entry) return null;
    const { type, count, valueOff } = entry;
    switch (type) {
      case 2: return r.ascii(valueOff, count).trim() || null;
      case 1: case 7: return r.u8(valueOff);
      case 3: return r.u16(valueOff, le);
      case 4: return r.u32(valueOff, le);
      case 9: return r.i32(valueOff, le);
      case 5: case 10: {
        const num = type === 5 ? r.u32(valueOff, le) : r.i32(valueOff, le);
        const den = type === 5 ? r.u32(valueOff + 4, le) : r.i32(valueOff + 4, le);
        return den ? num / den : null;
      }
      default: return null;
    }
  }

  const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
  const posOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

  /**
   * Parse the EXIF fields LightPlan uses. Returns null when the input is not a JPEG with an EXIF block, or
   * when the block is malformed or truncated. Missing individual fields are null.
   */
  function parseExif(input) {
    try {
      const view = toView(input);
      if (!view) return null;
      const r = reader(view);
      const tiff = findTiffStart(r);
      if (!tiff) return null;
      const b0 = r.u8(tiff.start), b1 = r.u8(tiff.start + 1);
      let le;
      if (b0 === 0x49 && b1 === 0x49) le = true; // "II"
      else if (b0 === 0x4d && b1 === 0x4d) le = false; // "MM"
      else return null;
      if (r.u16(tiff.start + 2, le) !== 42) return null;
      const ifd0Off = r.u32(tiff.start + 4, le);
      const ifd0 = readIfd(r, tiff, ifd0Off, le);

      let sub = {};
      const exifPtr = readValue(r, ifd0[TAG.EXIF_IFD], le);
      if (typeof exifPtr === 'number' && exifPtr > 0 && exifPtr !== ifd0Off) sub = readIfd(r, tiff, exifPtr, le);

      const orientation = readValue(r, ifd0[TAG.ORIENTATION], le);
      const focal35 = posOrNull(readValue(r, sub[TAG.FOCAL_35], le));
      const focalMm = posOrNull(readValue(r, sub[TAG.FOCAL_LENGTH], le));
      return {
        focal35,
        focalMm: focalMm == null ? null : Math.round(focalMm * 1000) / 1000,
        make: strOrNull(readValue(r, ifd0[TAG.MAKE], le)),
        model: strOrNull(readValue(r, ifd0[TAG.MODEL], le)),
        orientation: orientation >= 1 && orientation <= 8 ? orientation : null,
        width: posOrNull(readValue(r, sub[TAG.PIXEL_X], le)),
        height: posOrNull(readValue(r, sub[TAG.PIXEL_Y], le)),
        dateTime: strOrNull(readValue(r, sub[TAG.DATETIME_ORIGINAL], le)) || strOrNull(readValue(r, ifd0[TAG.DATETIME], le)),
      };
    } catch (e) {
      return null; // truncated or malformed (Truncated) or anything unexpected
    }
  }

  return { parseExif, TAG };
});

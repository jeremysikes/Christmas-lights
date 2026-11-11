/* LightPlan UI: image sources.
 *
 * An ImageSource is anything that can hand LightPlan one photo of a house. Phase 1 has three working sources
 * (file upload, the phone camera through the file picker, and the built-in sample house) and two Phase 2
 * placeholders (street-level imagery, aerial). New sources plug in through the registry without touching the rest of
 * the app.
 *
 *   interface ImageSource {
 *     id:     string                      unique id ('file', 'camera', 'sample', 'streetview', 'aerial')
 *     label:  string                      button text, plain words ("Choose photo")
 *     kind:   'upload'|'camera'|'sample'|'streetview'|'aerial'   → project image.source.kind
 *     isAvailable(): boolean              false hides or disables the source in the UI
 *     acquire(input): Promise<AcquiredImage>   input is source specific (a File for file/camera,
 *                                         {traced} for the sample, an address/location for Phase 2 sources)
 *   }
 *   AcquiredImage = {
 *     name, width, height,                pixels of the STORED image (downscaled to config.maxImageSide)
 *     dataUrl, mime,                      the stored pixels (JPEG for photos, PNG for the sample)
 *     exif,                               exif.parseExif result or null (focal35, focalMm, make, model, ...)
 *     source: {kind, attribution, license, capturedAt, address, lat, lng, heading, pitch, fov}
 *   }
 *   acquire() rejects with an Error whose message is plain and tells the user what to do.
 *
 * Decoding (file and camera): ArrayBuffer → exif.parseExif → createImageBitmap(blob,
 * {imageOrientation: 'from-image'}) so phone photos come out upright, with an <img> fallback → downscale so
 * the long side is at most config.maxImageSide → JPEG data URL at quality 0.9. Measurement math does not
 * depend on resolution, so downscaling only saves storage.
 *
 * Deviations from SPEC (additive): SampleImageSource.acquire also returns `sample` (the full
 * sample.createSample result, including the traced project). Extra exports: decodeArrayBuffer, decodeFile,
 * loadElement(dataUrl) → Promise<HTMLImageElement>, renderSample(primitives, width, height) → canvas,
 * isHeic(name, mime), maxImageSide().
 */
LP.define('ui.imagesource', ['exif', 'catalog', 'sample'], function (exif, catalog, sample) {
  'use strict';

  const JPEG_QUALITY = 0.9;

  function maxImageSide() {
    const v = catalog.DEFAULT_CONFIG.maxImageSide;
    return Number.isFinite(v) && v > 0 ? v : 2048;
  }

  /** HEIC/HEIF photos (iPhone default) do not decode in most non-Safari browsers. */
  function isHeic(name, mime) {
    return /image\/hei[cf]/i.test(String(mime || '')) || /\.(heic|heif)$/i.test(String(name || ''));
  }

  function undecodableMessage(name, mime) {
    if (isHeic(name, mime)) {
      return 'This photo is in HEIC format, which this browser cannot open. On your phone, export it as JPEG ' +
        '(or take a screenshot of it) and choose that file instead.';
    }
    return 'This file could not be opened as a photo. Choose a JPEG or PNG image, or take a screenshot of the photo and use that.';
  }

  function emptySource(kind, extra) {
    return Object.assign({
      kind, attribution: null, license: null, capturedAt: null, address: null, lat: null, lng: null, heading: null, pitch: null, fov: null,
    }, extra || {});
  }

  /** EXIF "2024:11:08 17:02:11" → ISO-like "2024-11-08T17:02:11" (local time, no zone), or null. */
  function exifDateToIso(s) {
    const m = typeof s === 'string' ? s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/) : null;
    return m ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] : null;
  }

  /** Decode a Blob into something drawable: ImageBitmap (EXIF-oriented) or an <img>. */
  function decodeBlob(blob) {
    const viaImg = () => new Promise((resolve, reject) => {
      let url = null;
      try { url = URL.createObjectURL(blob); } catch (e) { url = null; }
      const img = new Image();
      const done = () => { if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } } };
      img.onload = () => { done(); resolve(img); };
      img.onerror = () => {
        done();
        if (!url) { reject(new Error('decode failed')); return; }
        // Some frames block blob: URLs; retry through a data URL.
        try {
          const fr = new FileReader();
          fr.onload = () => {
            const img2 = new Image();
            img2.onload = () => resolve(img2);
            img2.onerror = () => reject(new Error('decode failed'));
            img2.src = String(fr.result);
          };
          fr.onerror = () => reject(new Error('decode failed'));
          fr.readAsDataURL(blob);
        } catch (e) { reject(new Error('decode failed')); }
      };
      if (url) img.src = url; else img.onerror();
    });
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(viaImg);
    }
    return viaImg();
  }

  function sizeOf(el) {
    const w = el.naturalWidth || el.videoWidth || el.width || 0;
    const h = el.naturalHeight || el.videoHeight || el.height || 0;
    return { w, h };
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /**
   * Decode raw file bytes into an AcquiredImage. opts: {name, mime, kind, maxSide}.
   * Rejects with a plain-language Error when the bytes are not a photo this browser can open.
   */
  function decodeArrayBuffer(buffer, opts) {
    const o = opts || {};
    const name = o.name || 'photo.jpg';
    const mime = o.mime || 'image/jpeg';
    const maxSide = Number.isFinite(o.maxSide) && o.maxSide > 0 ? o.maxSide : maxImageSide();
    let meta = null;
    try { meta = exif.parseExif(buffer); } catch (e) { meta = null; }
    let blob;
    try { blob = new Blob([buffer], { type: mime }); } catch (e) { return Promise.reject(new Error(undecodableMessage(name, mime))); }
    return decodeBlob(blob).then((el) => {
      const { w, h } = sizeOf(el);
      if (!(w > 0 && h > 0)) throw new Error('empty');
      const k = Math.min(1, maxSide / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * k));
      const ch = Math.max(1, Math.round(h * k));
      const canvas = makeCanvas(cw, ch);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // JPEG has no alpha; transparent PNG areas become white, not black
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(el, 0, 0, cw, ch);
      if (typeof el.close === 'function') { try { el.close(); } catch (e) { /* ImageBitmap */ } }
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const exifOut = meta ? {
        focal35: meta.focal35 || null, focalMm: meta.focalMm || null, make: meta.make || null, model: meta.model || null,
        orientation: meta.orientation || null, width: meta.width || null, height: meta.height || null, dateTime: meta.dateTime || null,
      } : null;
      return {
        name, width: cw, height: ch, dataUrl, mime: 'image/jpeg', exif: exifOut,
        source: emptySource(o.kind || 'upload', { capturedAt: meta ? exifDateToIso(meta.dateTime) : null }),
      };
    }).catch(() => {
      // Whatever failed (decode, an empty image, a canvas error), the user-facing advice is the same.
      throw new Error(undecodableMessage(name, mime));
    });
  }

  /** Read a File/Blob and decode it. Rejects with a plain message for non-images and unreadable files. */
  function decodeFile(file, kind) {
    if (!file || typeof file !== 'object') return Promise.reject(new Error('No photo was chosen.'));
    const name = file.name || 'photo.jpg';
    const mime = file.type || '';
    if (mime && !/^image\//i.test(mime) && !isHeic(name, mime)) {
      return Promise.reject(new Error('"' + name + '" is not a photo. Choose a JPEG or PNG image.'));
    }
    const read = typeof file.arrayBuffer === 'function'
      ? file.arrayBuffer()
      : new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('read failed'));
        fr.readAsArrayBuffer(file);
      });
    return read.then(
      (buf) => decodeArrayBuffer(buf, { name, mime: mime || 'image/jpeg', kind }),
      () => { throw new Error('"' + name + '" could not be read. Try choosing it again.'); });
  }

  /** Load a data URL into an <img> element (for photos restored from storage or a project file). */
  function loadElement(dataUrl) {
    return new Promise((resolve, reject) => {
      if (typeof dataUrl !== 'string' || !dataUrl) { reject(new Error('No photo data.')); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The saved photo could not be opened.'));
      img.src = dataUrl;
    });
  }

  /** Draw sample primitives onto a fresh canvas. */
  function renderSample(primitives, width, height) {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    sample.drawPrimitives(ctx, primitives);
    return canvas;
  }

  // ---------------------------------------------------------------- sources
  const FileImageSource = {
    id: 'file',
    label: 'Choose photo',
    kind: 'upload',
    isAvailable: () => typeof FileReader !== 'undefined' || typeof Blob !== 'undefined',
    acquire: (file) => decodeFile(file, 'upload'),
  };

  /** The phone camera through <input type="file" accept="image/*" capture="environment"> (live camera APIs are blocked). */
  const CameraImageSource = {
    id: 'camera',
    label: 'Take photo',
    kind: 'camera',
    isAvailable: () => typeof FileReader !== 'undefined' || typeof Blob !== 'undefined',
    acquire: (file) => decodeFile(file, 'camera').then((img) => {
      img.source.kind = 'camera';
      return img;
    }),
  };

  /** The built-in sample house, rendered from vector primitives (never stored; regenerated on load). */
  const SampleImageSource = {
    id: 'sample',
    label: 'Use sample house',
    kind: 'sample',
    isAvailable: () => typeof document !== 'undefined',
    acquire(input) {
      return new Promise((resolve, reject) => {
        try {
          const traced = !(input && input.traced === false);
          const s = sample.createSample({ traced });
          const canvas = renderSample(s.primitives, s.width, s.height);
          resolve({
            name: 'Sample house', width: s.width, height: s.height,
            dataUrl: canvas.toDataURL('image/png'), mime: 'image/png', exif: null,
            source: emptySource('sample', { attribution: 'LightPlan sample house (generated)' }),
            sample: s, canvas,
          });
        } catch (e) {
          reject(new Error('The sample house could not be drawn in this browser.'));
        }
      });
    },
  };

  /*
   * Phase 2 placeholder: a street-level imagery service. The providers' terms generally do not allow storing
   * their imagery, require their attribution to stay visible on it, and prohibit tracing or measuring from it;
   * any use needs an API key (billing) and a review of the provider's current terms (see the roadmap). Until a
   * licensed source is chosen this stays unavailable. Users can upload a photo or screenshot they are allowed to
   * use and pick the "Screenshot (wide view)" lens preset. The id and kind keep their Phase 1 value ('streetview')
   * so saved projects stay readable.
   */
  const StreetViewImageSource = {
    id: 'streetview',
    label: 'Street-level imagery (not available)',
    kind: 'streetview',
    isAvailable: () => false,
    acquire: () => Promise.reject(new Error('Street-level imagery is not available. Take a photo, or upload one you are allowed to use.')),
  };

  /*
   * Phase 2: aerial / satellite imagery (e.g. Nearmap, EagleView, Google Maps tiles) for roof outlines and
   * ridge lengths seen from above. Each provider has its own license: most forbid storing tiles, require
   * attribution and per-request billing, and some sell measurement rights separately. A backend proxy will be
   * needed to keep keys secret. Unavailable until a provider and license are chosen.
   */
  const AerialImageSource = {
    id: 'aerial',
    label: 'Aerial view (coming later)',
    kind: 'aerial',
    isAvailable: () => false,
    acquire: () => Promise.reject(new Error('Aerial photos are not available yet.')),
  };

  // ---------------------------------------------------------------- registry
  const registry = new Map();
  function register(source) {
    if (!source || typeof source.id !== 'string' || typeof source.acquire !== 'function' || typeof source.isAvailable !== 'function') {
      throw new Error('An image source needs an id, isAvailable() and acquire().');
    }
    registry.set(source.id, source);
    return source;
  }
  function get(id) { return registry.get(id) || null; }
  function list() { return Array.from(registry.values()); }

  [FileImageSource, CameraImageSource, SampleImageSource, StreetViewImageSource, AerialImageSource].forEach(register);

  return {
    register, get, list,
    FileImageSource, CameraImageSource, SampleImageSource, StreetViewImageSource, AerialImageSource,
    decodeArrayBuffer, decodeFile, loadElement, renderSample, isHeic, maxImageSide, undecodableMessage,
  };
});

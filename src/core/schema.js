/* LightPlan core: schema (SPEC §4 and §5.9).
 * The persisted data model: id generation, factories that fill every field with its default,
 * normalization of partial or damaged input, version migration, readable validation, the JSON Schema
 * (draft 2020-12) published as schema/project.schema.json, and the JSON export/import wrapper.
 *
 * Pure: no DOM and no clock. The only impurity is uid(), which falls back to Math.random when no
 * seeded generator is passed (factories are called by the UI when the user creates something).
 * normalizeProject is fully deterministic: ids it has to invent are derived from position.
 *
 * Deviations from SPEC §5.9 (documented signatures unchanged; these are additive refinements):
 *  - Factories accept opts.id and opts.rng (a () => [0,1) generator passed to uid) so tests can make
 *    deterministic objects. createProject also accepts opts.now (ISO string) for createdAt/updatedAt;
 *    without it both are null, because core code never reads the clock.
 *  - settings.roofPitch defaults to null (unknown, so measure.js estimates it from gable rakes and
 *    falls back to 6/12). A 6/12 default would silently block the estimate.
 *  - normalizeProject keeps unknown keys (deep-cloned) on the project, on each entity and on every nested
 *    object it rebuilds (settings, customer, quote, library, pricing, image source/camera/exif, plane rect
 *    and derived, feature params and color) so newer optional fields survive a round trip, drops the top-level "derived" key (derived results are never trusted
 *    from input), nulls references that point at missing items, infers a missing imageId from the
 *    item's plane or the active image, drops calibration refs whose point count is wrong, and keeps
 *    features of unknown type (validateProject reports them).
 *  - validateProject (and so importProject) checks each custom product like the product editor does: a known
 *    category and unit, price and wattsPerUnit numbers of 0 or more, stringLengthFt and maxEndToEnd above 0,
 *    unique ids. ENUMS gains productCategory, productUnit and productTech.
 *  - importProject reads the export wrapper version like migrateProject reads a project version (numeric
 *    strings count, non-integers are refused), so "2" is refused as newer instead of opened as version 1.
 *  - quoteFieldProblem(field, value) → plain reason or null: the quote rules of normalizeProject, for the UI.
 *  - importProject also accepts a JSON string. Extra exports: EXPORT_SCHEMA_ID, EXPORT_VERSION,
 *    ENUMS, ID_PREFIX, createDefaultSettings, createDefaultQuote.
 *
 * Phase 1.1 (SPEC §8.3 and §8.4). All of these are optional, so a project saved before them is still
 * "already normalized" (nothing is added when a field is missing):
 *  - library.supplierId (text or null): who the project buys from. Kept when present.
 *  - library.config.buying {style, costBasis}: a value that is not a known word is dropped (the default applies).
 *  - Supplier fields on products (supplierId, supplierSku, url, priceAsOf, priceStatus, equiv, kind, components)
 *    are kept as they are, with two repairs: a link (product.url and every url inside components) that is not a
 *    plain https address is dropped, and so is a priceStatus that is not 'verified' or 'observed'.
 *    validateProject reports both.
 *  - tapErr (expected tap error per point, stored-image pixels) beside rect.corners, ref.points, feature.points
 *    and plane.derived.line: kept only when it is a list of finite numbers of 0 or more with exactly one entry
 *    per point; otherwise dropped silently (no information = the 2.5 px default).
 *  - ENUMS gains priceStatus, productKind, buyingStyle and costBasis.
 */
LP.define('schema', ['geometry', 'catalog', 'suppliers'], function (geometry, catalog, suppliers) {
  'use strict';

  const SCHEMA_ID = 'lightplan/project';
  const SCHEMA_VERSION = 1;
  const EXPORT_SCHEMA_ID = 'lightplan/export';
  const EXPORT_VERSION = 1;
  const ID_PREFIX = { project: 'prj', image: 'img', plane: 'pl', ref: 'ref', feature: 'ft', outlet: 'out', circuit: 'cir' };
  const ENUMS = {
    colorMode: ['warmWhite', 'coolWhite', 'multicolor', 'custom'],
    lengthFormat: ['ft-in', 'ft-decimal'],
    sourceKind: ['upload', 'camera', 'sample', 'streetview', 'aerial'],
    cameraMode: ['auto', 'exif', 'preset', 'manual'],
    planeKind: ['wall', 'roof', 'ground'],
    refKind: ['line', 'rect'],
    quality: ['high', 'medium', 'low'],
    mount: ['gutter', 'shingle', 'allInOne', 'ridge', 'adhesive', 'zipTie', 'stake', 'none'],
    wrapMode: ['trunk', 'canopy'],
    outletType: ['exteriorGfci', 'garage', 'interior', 'other'],
    laborMethod: ['perFt', 'perHour'],
    featureType: catalog.TYPE_ORDER.slice(),
    productCategory: ['c9', 'c7', 'mini', 'icicle', 'net', 'rope', 'track', 'path', 'treewrap'],
    productUnit: ['string', 'net', 'set', 'foot'],
    productTech: ['LED', 'incandescent'],
    priceStatus: suppliers.PRICE_STATUSES.slice(),
    productKind: ['bulk'],
    buyingStyle: catalog.BUYING_STYLES.slice(),
    costBasis: catalog.COST_BASES.slice(),
  };
  const PLANE_COLORS = { wall: '#4f9dff', roof: '#ff8a3d', ground: '#7bd88f' };
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  const NOT_A_PROJECT = 'This file is not a LightPlan project.';

  // ================================================================ JSON Schema (draft 2020-12)
  // Kept in sync with schema/project.schema.json (tests/schema.test.js compares them deeply).
  // To regenerate the file: node -e "require('./tests/loader');console.log(JSON.stringify(
  //   LP.require('schema').JSON_SCHEMA,null,2))" > schema/project.schema.json
  const ref = (name) => ({ $ref: '#/$defs/' + name });
  const JSON_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:lightplan:schema:project:1',
    title: 'LightPlan project',
    description: 'A persisted LightPlan project, format version 1. Lengths are feet, image points are pixels of ' +
      'the stored (downscaled) image with the origin at the top-left and y down, and angles are degrees. ' +
      'Ids are strings with a type prefix (prj_, img_, pl_, ref_, ft_, out_, cir_). null means "not set, use the ' +
      'default". Derived results are never stored here; exports carry them under a separate "derived" key ' +
      '(see #/$defs/exportFile).',
    type: 'object',
    required: ['schema', 'version', 'id', 'name', 'createdAt', 'updatedAt', 'customer', 'settings', 'images',
      'activeImageId', 'planes', 'features', 'outlets', 'circuits', 'library', 'pricing', 'quote'],
    properties: {
      schema: { const: SCHEMA_ID, description: 'Format marker. Always "lightplan/project".' },
      version: { const: SCHEMA_VERSION, description: 'Format version. Older versions are upgraded by migrateProject; newer ones are refused.' },
      id: { type: 'string', minLength: 1, description: 'Project id, e.g. "prj_ab12cd34".' },
      name: { type: 'string', description: 'Project name shown in the app and on reports, usually the street address.' },
      createdAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'When the project was created (ISO 8601), or null if unknown.' },
      updatedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'When the project was last changed (ISO 8601), or null if unknown.' },
      customer: ref('customer'),
      settings: ref('settings'),
      images: { type: 'array', items: ref('image'), description: 'Photos of the house. Pixels are stored separately under each image\'s storageKey.' },
      activeImageId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Id of the photo shown in the editor, or null when there are no photos.' },
      planes: { type: 'array', items: ref('plane'), description: 'Measurement planes: walls calibrated from a perspective rectangle and references, and roof or ground planes derived from a wall.' },
      features: { type: 'array', items: ref('feature'), description: 'Traced parts of the house that get lights (rooflines, windows, bushes, trees and so on).' },
      outlets: { type: 'array', items: ref('outlet'), description: 'Power outlets marked on the photos.' },
      circuits: { type: 'array', items: ref('circuit'), description: 'Breaker circuits the outlets belong to.' },
      library: ref('library'),
      pricing: ref('pricing'),
      quote: ref('quote'),
    },
    $defs: {
      point: {
        type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' },
        description: 'Image point [x, y] in pixels of the stored image; origin top-left, y down.',
      },
      pointList: { type: 'array', items: ref('point'), description: 'Image points in tap order.' },
      tapErr: {
        type: 'array', items: { type: 'number', minimum: 0 },
        description: 'Optional. Expected tap error (1 sigma) of each point beside it, in pixels of the stored image, index for index. ' +
          'Set by the editor from the zoom at the moment of the tap. Missing, or not one number per point = no information (2.5 px is assumed).',
      },
      quad: {
        type: 'array', minItems: 4, maxItems: 4, items: ref('point'),
        description: 'Four image points as tapped. Order them with geometry.orderQuad to get [TL, TR, BR, BL].',
      },
      hexColor: { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$', description: 'CSS hex color, e.g. "#ffc46b".' },
      pitch: {
        type: 'object', required: ['rise', 'run'],
        description: 'Roof pitch as rise over run, e.g. 6/12.',
        properties: {
          rise: { type: 'number', minimum: 0, description: 'Rise in inches per run.' },
          run: { type: 'number', exclusiveMinimum: 0, description: 'Run in inches, normally 12.' },
        },
      },
      customer: {
        type: 'object', required: ['name', 'address', 'phone', 'email'],
        description: 'Customer details printed on the quote.',
        properties: {
          name: { type: 'string', description: 'Customer name.' },
          address: { type: 'string', description: 'Street address of the job.' },
          phone: { type: 'string', description: 'Phone number as typed.' },
          email: { type: 'string', description: 'Email address as typed.' },
        },
      },
      settings: {
        type: 'object', required: ['wastePct', 'roofPitch', 'colorMode', 'customColors', 'lengthFormat'],
        description: 'Project-wide planning settings.',
        properties: {
          wastePct: { type: 'number', minimum: 0, maximum: 100, description: 'Percent added to every linear run (and to clip counts) for waste, corners and drops. Default 10.' },
          roofPitch: { anyOf: [ref('pitch'), { type: 'null' }], description: 'Project default roof pitch. null = unknown: estimated from gable rakes traced on a wall, else 6/12 is assumed.' },
          colorMode: { enum: ENUMS.colorMode.slice(), description: 'Default light color for every run: warmWhite, coolWhite, multicolor or custom.' },
          customColors: { type: 'array', items: ref('hexColor'), description: 'Colors used when colorMode is "custom" (cycled along each run).' },
          lengthFormat: { enum: ENUMS.lengthFormat.slice(), description: 'How lengths are shown: "ft-in" (32′ 4″) or "ft-decimal" (32.3 ft).' },
        },
      },
      image: {
        type: 'object', required: ['id', 'name', 'width', 'height', 'source', 'exif', 'camera', 'storageKey'],
        description: 'One photo. Pixels live in browser storage (Phase 2: object storage) under storageKey.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Image id, e.g. "img_1".' },
          name: { type: 'string', description: 'Original file name, e.g. "front.jpg".' },
          width: { type: 'number', exclusiveMinimum: 0, description: 'Width of the stored image in pixels (long side at most config.maxImageSide).' },
          height: { type: 'number', exclusiveMinimum: 0, description: 'Height of the stored image in pixels.' },
          source: ref('imageSource'),
          exif: { anyOf: [ref('exif'), { type: 'null' }], description: 'Camera data read from the JPEG, or null when the file had none.' },
          camera: ref('cameraSettings'),
          storageKey: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Key of the stored pixels (IndexedDB/localStorage in Phase 1). Exports carry the pixels as data URLs under this key.' },
        },
      },
      imageSource: {
        type: 'object', required: ['kind', 'capturedAt', 'attribution'],
        description: 'Where the photo came from.',
        properties: {
          kind: { enum: ENUMS.sourceKind.slice(), description: 'upload, camera (phone camera through the file picker), sample, streetview or aerial.' },
          capturedAt: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'When the photo was taken (from EXIF), or null.' },
          attribution: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Credit line required by the image source, or null.' },
        },
      },
      exif: {
        type: 'object', required: ['focal35', 'focalMm', 'make', 'model'],
        description: 'Subset of JPEG EXIF used for the camera model.',
        properties: {
          focal35: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: '35 mm-equivalent focal length (EXIF 0xA405).' },
          focalMm: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Actual focal length in millimetres (EXIF 0x920A).' },
          make: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Camera maker, e.g. "Apple".' },
          model: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Camera model, e.g. "iPhone 15".' },
          orientation: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'EXIF orientation tag (1-8), when present.' },
          width: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Pixel width recorded in EXIF, when present.' },
          height: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Pixel height recorded in EXIF, when present.' },
          dateTime: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'DateTimeOriginal as written by the camera, when present.' },
        },
      },
      cameraSettings: {
        type: 'object', required: ['mode', 'presetId', 'focalPx'],
        description: 'How the focal length is chosen for this photo.',
        properties: {
          mode: { enum: ENUMS.cameraMode.slice(), description: 'auto (EXIF, else estimated from a wall rectangle, else phone 1x), exif, preset or manual.' },
          presetId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Camera preset id (camera.CAMERA_PRESETS) used in preset mode, e.g. "phone1x".' },
          focalPx: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Focal length in pixels of the stored image, used in manual mode.' },
        },
      },
      plane: {
        type: 'object', required: ['id', 'imageId', 'name', 'kind', 'color', 'rect', 'refs', 'derived'],
        description: 'A flat surface of the house used for measuring. Walls: plane coordinates [u, v] in feet, u right, v up, origin at the rectangle\'s bottom-left corner. Roof and ground: [a, b] feet, a along the defining line, b across it (up-slope or toward the street).',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Plane id, e.g. "pl_front".' },
          imageId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Photo this plane is traced on.' },
          name: { type: 'string', description: 'Plane name, e.g. "Front wall".' },
          kind: { enum: ENUMS.planeKind.slice(), description: 'wall (vertical), roof (sloped, derived from a wall eave) or ground (horizontal, derived from a wall base).' },
          color: ref('hexColor'),
          rect: { anyOf: [ref('planeRect'), { type: 'null' }], description: 'Perspective rectangle on this wall (e.g. a garage door or the facade corners), or null.' },
          refs: { type: 'array', items: ref('ref'), description: 'Calibration references (known lengths or rectangles) lying on this plane.' },
          derived: { anyOf: [ref('planeDerived'), { type: 'null' }], description: 'For roof and ground planes: how the plane hangs off its parent wall. null for walls.' },
        },
      },
      planeRect: {
        type: 'object', required: ['corners', 'widthFt', 'heightFt', 'presetId'],
        description: 'A real rectangle on the wall seen in perspective. Gives the perspective correction (homography).',
        properties: {
          corners: ref('quad'),
          widthFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'True width in feet; null with heightFt null = size unknown (scale then comes from refs).' },
          heightFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'True height in feet; null = size unknown.' },
          presetId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Rectangle preset (measure.WALL_RECT_PRESETS), e.g. "garage-double".' },
          tapErr: { $ref: '#/$defs/tapErr', minItems: 4, maxItems: 4, description: 'Optional tap error of each of the 4 corners (see #/$defs/tapErr).' },
        },
      },
      planeDerived: {
        type: 'object', required: ['parentPlaneId', 'line', 'pitch'],
        description: 'Roof: line is the eave on the parent wall and the plane slopes up and away at pitch. Ground: line is the wall base and the plane is horizontal toward the camera (pitch ignored).',
        properties: {
          parentPlaneId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Id of the wall this plane is built from.' },
          line: { anyOf: [{ type: 'array', minItems: 2, maxItems: 2, items: ref('point') }, { type: 'null' }], description: 'Two image points on the parent wall: the eave (roof) or the wall base (ground).' },
          pitch: { anyOf: [ref('pitch'), { type: 'null' }], description: 'Roof pitch for this plane; null = project roofPitch, else estimated, else 6/12.' },
          tapErr: { $ref: '#/$defs/tapErr', minItems: 2, maxItems: 2, description: 'Optional tap error of the 2 points of line (see #/$defs/tapErr).' },
        },
      },
      ref: {
        type: 'object', required: ['id', 'kind', 'points', 'presetId', 'quality'],
        description: 'A calibration reference: a line of known length (or N siding/brick courses) or a rectangle of known size.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Reference id, e.g. "ref_1".' },
          kind: { enum: ENUMS.refKind.slice(), description: 'line (2 points) or rect (4 points).' },
          points: ref('pointList'),
          lengthFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Line refs: true length in feet (courses refs: courses × course height).' },
          courses: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], description: 'Line refs from a siding or brick preset: number of courses spanned; null otherwise.' },
          widthFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Rect refs: true width in feet.' },
          heightFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Rect refs: true height in feet.' },
          presetId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Reference preset (measure.REF_PRESETS), e.g. "door-height".' },
          quality: { enum: ENUMS.quality.slice(), description: 'How much to trust it: high (door, garage door), medium (siding, brick), low.' },
          tapErr: { $ref: '#/$defs/tapErr', description: 'Optional tap error of each point: 2 numbers for a line, 4 for a rect (see #/$defs/tapErr).' },
        },
        allOf: [
          { if: { properties: { kind: { const: 'line' } } }, then: { properties: { points: { minItems: 2, maxItems: 2 } } } },
          { if: { properties: { kind: { const: 'rect' } } }, then: { properties: { points: { minItems: 4, maxItems: 4 } } } },
        ],
      },
      feature: {
        type: 'object', required: ['id', 'imageId', 'planeId', 'type', 'label', 'points', 'closed', 'overrideFt', 'productId', 'color', 'params'],
        description: 'A traced part of the house that gets lights.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Feature id, e.g. "ft_1". Its light run is "run_" + id.' },
          imageId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Photo the points are traced on.' },
          planeId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Plane used to measure it; null = not measurable yet.' },
          type: { enum: ENUMS.featureType.slice(), description: 'Feature type (catalog.FEATURE_TYPES). Geometry: polyline, polygon, vertical (2 points, base then top) or area.' },
          label: { type: 'string', description: 'Name shown in lists and the checklist, e.g. "Front eave".' },
          points: ref('pointList'),
          closed: { type: 'boolean', description: 'True when the outline loops back to its first point (windows, bushes).' },
          overrideFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Tape-measured length in feet that replaces the measured one. Polyline/polygon: length or perimeter; tree/column: height (wrap length is recomputed); bush: ignored.' },
          productId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Product to use; null = the type default from the library config.' },
          color: { anyOf: [ref('featureColor'), { type: 'null' }], description: 'Color for this run; null = project colorMode.' },
          params: ref('featureParams'),
          tapErr: { $ref: '#/$defs/tapErr', description: 'Optional tap error of each point, one number per point (see #/$defs/tapErr).' },
        },
      },
      featureColor: {
        type: 'object', required: ['mode'],
        description: 'Per-feature color override.',
        properties: {
          mode: { enum: ENUMS.colorMode.slice(), description: 'Color mode for this run.' },
          colors: { type: 'array', items: ref('hexColor'), description: 'Colors for mode "custom".' },
        },
      },
      featureParams: {
        type: 'object', required: ['mount', 'diameterIn', 'spiralSpacingIn', 'wrapMode', 'outletId', 'reverse', 'overrideWidthFt', 'overrideHeightFt'],
        description: 'Type-specific options. null = the type default.',
        properties: {
          mount: { anyOf: [{ enum: ENUMS.mount.slice() }, { type: 'null' }], description: 'How the lights attach (sets the clip type): gutter, shingle, allInOne, ridge, adhesive, zipTie, stake or none.' },
          diameterIn: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Tree trunk or column diameter in inches.' },
          spiralSpacingIn: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Vertical gap between wraps in inches (tree, column).' },
          wrapMode: { anyOf: [{ enum: ENUMS.wrapMode.slice() }, { type: 'null' }], description: 'Trees: trunk (spiral wrap) or canopy (planned by light count).' },
          outletId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Force this run to be powered from this outlet.' },
          reverse: { type: 'boolean', description: 'Start the run at its last point instead of letting the planner choose.' },
          ownCord: { type: 'boolean', description: 'Give this run its own cord from the outlet: no jumper to or from another run. Optional; missing means false.' },
          overrideWidthFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Bushes: tape-measured width in feet.' },
          overrideHeightFt: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }], description: 'Bushes: tape-measured height in feet.' },
        },
      },
      outlet: {
        type: 'object', required: ['id', 'imageId', 'planeId', 'point', 'label', 'type', 'gfci', 'circuitId', 'receptacles'],
        description: 'A power outlet marked on a photo.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Outlet id, e.g. "out_1".' },
          imageId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Photo the outlet is marked on.' },
          planeId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Plane the outlet sits on (used to measure cord length).' },
          point: { anyOf: [ref('point'), { type: 'null' }], description: 'Image point of the outlet.' },
          label: { type: 'string', description: 'Name, e.g. "Porch outlet".' },
          type: { enum: ENUMS.outletType.slice(), description: 'exteriorGfci, garage, interior or other.' },
          gfci: { type: 'boolean', description: 'True when the outlet is GFCI protected. Unprotected outlets get a portable GFCI adapter in the BOM.' },
          circuitId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Breaker circuit this outlet is on; null = unknown (assumed alone on a 15 A breaker).' },
          receptacles: { type: 'integer', minimum: 1, description: 'Number of sockets on the outlet.' },
        },
      },
      circuit: {
        type: 'object', required: ['id', 'name', 'breakerAmps', 'voltage', 'existingLoadW'],
        description: 'A breaker circuit. Safe continuous limit = breakerAmps × voltage × 0.8.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Circuit id, e.g. "cir_1".' },
          name: { type: 'string', description: 'Name, e.g. "Porch circuit".' },
          breakerAmps: { type: 'number', exclusiveMinimum: 0, description: 'Breaker rating in amps (15 or 20 in most homes).' },
          voltage: { type: 'number', exclusiveMinimum: 0, description: 'Circuit voltage (120 in North America).' },
          existingLoadW: { type: 'number', minimum: 0, description: 'Watts already used on this circuit by other things while the lights are on.' },
        },
      },
      library: {
        type: 'object', required: ['products', 'config'],
        description: 'Project overrides of the product library and rules of thumb.',
        properties: {
          products: { anyOf: [{ type: 'array', minItems: 1, items: ref('product') }, { type: 'null' }], description: 'Full replacement product list; null = catalog defaults. Supplier products that are not in the list are added from the supplier map when the plan is computed.' },
          config: {
            anyOf: [{ type: 'object', properties: { buying: ref('buying') } }, { type: 'null' }],
            description: 'Overrides deep-merged into catalog.DEFAULT_CONFIG (clip spacing, labor rates, power limits, buying and so on); null = defaults.',
          },
          supplierId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }], description: 'Optional. Who the project buys from: "generic" (any store), "cle" (Christmas Lights Etc) or "1000bulbs". Missing, null or an unknown id = any store.' },
        },
      },
      buying: {
        type: 'object',
        description: 'How C7/C9 from the chosen supplier is bought and costed (library.config.buying). Both keys are optional.',
        properties: {
          style: { enum: ENUMS.buyingStyle.slice(), description: 'bulk = socket wire cut to length, bulbs by the box and slide-on plugs (default); strings = ready-made strings.' },
          costBasis: { enum: ENUMS.costBasis.slice(), description: 'bought = the plan costs everything that is ordered (default); used = only the share of bulk wire, bulbs and plugs this job uses.' },
        },
      },
      offer: {
        type: 'object', required: ['sku', 'price'],
        description: 'One thing that can be ordered from a supplier: a bulk component (wire, a bulb colour, a plug) or an accessory.',
        properties: {
          sku: { type: 'string', minLength: 1, description: 'Price key for pricing.overrides: "<supplierId>:<supplierSku>" (a short name instead of the part number when that is not confirmed).' },
          supplierSku: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The part number to type at the supplier; null = not confirmed, order from the link.' },
          name: { type: 'string', description: 'Name shown in the BOM.' },
          url: { anyOf: [{ type: 'string', pattern: '^https://' }, { type: 'null' }], description: 'Product page (https only).' },
          price: { type: 'number', minimum: 0, description: 'Price of one pack, spool or piece in USD.' },
          packQty: { type: 'number', exclusiveMinimum: 0, description: 'How many come in one pack.' },
          priceAsOf: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Day the price was seen (YYYY-MM-DD).' },
          priceStatus: { enum: ENUMS.priceStatus.slice(), description: 'verified = seen on the supplier\'s page that day; observed = seen in a search result, not confirmed.' },
          notes: { type: 'string', description: 'A short caution printed on the BOM line.' },
        },
      },
      bulkComponents: {
        type: 'object', required: ['wire', 'bulb'],
        description: 'The parts a bulk C7/C9 product is bought as (product.kind "bulk").',
        properties: {
          wire: {
            $ref: '#/$defs/offer',
            description: 'Socket wire by the spool (an offer with the extra fields below).',
            properties: {
              spoolFt: { type: 'number', exclusiveMinimum: 0, description: 'Feet of wire on the spool.' },
              wireType: { enum: ['SPT-1', 'SPT-2'], description: 'Insulation grade of the wire; slide-on plugs must match it.' },
              maxAmps: { type: 'number', exclusiveMinimum: 0, description: 'Amp rating of the wire as the supplier lists it (the lower figure when the listing gives two).' },
              sizes: {
                type: 'array', description: 'Other lengths of the same wire that can be bought, for jobs that do not need a whole spool.',
                items: { $ref: '#/$defs/offer', properties: { lengthFt: { type: 'number', exclusiveMinimum: 0, description: 'Feet of wire in this length.' } } },
              },
            },
          },
          bulb: {
            type: 'object', required: ['packQty', 'wattsEach', 'defaultVariant', 'variants'],
            description: 'Screw-in bulbs by the pack, one offer per colour sold.',
            properties: {
              name: { type: 'string', description: 'Name of the bulb family without a colour, used for a colour that is not on file.' },
              packQty: { type: 'number', exclusiveMinimum: 0, description: 'Bulbs in one pack.' },
              wattsEach: { type: 'number', minimum: 0, description: 'Watts per bulb as the supplier lists it.' },
              base: { enum: ['E17', 'E12'], description: 'Screw base: E17 (C9) or E12 (C7).' },
              defaultVariant: { type: 'string', description: 'Key in variants used for pricing a colour the supplier does not list.' },
              variants: { type: 'object', additionalProperties: ref('offer'), description: 'Colour key (warmWhite, coolWhite, multi, red, green, blue...) to the offer for that colour.' },
            },
          },
          plugMale: { anyOf: [ref('offer'), { type: 'null' }], description: 'Slide-on male plug; null = none on file (the BOM lists a plain plug line).' },
          plugFemale: { anyOf: [ref('offer'), { type: 'null' }], description: 'Slide-on female plug; null = none on file.' },
        },
      },
      product: {
        type: 'object', required: ['id', 'category', 'unit', 'stringLengthFt', 'wattsPerUnit', 'maxEndToEnd', 'price'],
        description: 'A light product (catalog Product). Import refuses a product without a valid category, unit, lit length, watts, end-to-end limit or price; the planner also skips products whose data it cannot use and says so.',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Product id, e.g. "c9-led".' },
          sku: { type: 'string', description: 'Price key: pricing.overrides and BOM lines use it.' },
          name: { type: 'string', description: 'Name shown in the BOM.' },
          category: { enum: ENUMS.productCategory.slice(), description: 'Product family.' },
          tech: { enum: ENUMS.productTech.slice(), description: 'Bulb technology.' },
          unit: { enum: ENUMS.productUnit.slice(), description: 'What one purchasable unit is.' },
          bulbSpacingIn: { type: 'number', description: 'Inches between bulbs.' },
          stringLengthFt: { type: 'number', exclusiveMinimum: 0, description: 'Lit length per unit in feet.' },
          leadFt: { type: 'number', description: 'Unlit lead length in feet.' },
          bulbsPerUnit: { type: 'number', description: 'Bulbs per unit.' },
          wattsPerUnit: { type: 'number', minimum: 0, description: 'Watts per string/net/set, or per foot when unit is "foot".' },
          maxEndToEnd: { type: 'number', exclusiveMinimum: 0, description: 'Most units that may be connected end to end on one feed.' },
          coverageSqFt: { type: 'number', description: 'Net lights only: area one net covers.' },
          stakesPerSet: { type: 'number', description: 'Path lights only: stakes per set.' },
          stakeSpacingIn: { type: 'number', description: 'Path lights only: inches between stakes.' },
          dropLengthsIn: { type: 'array', items: { type: 'number' }, description: 'Icicle lights: drop lengths used by the preview.' },
          price: { type: 'number', minimum: 0, description: 'Default unit price in USD.' },
          colors: { type: 'array', items: { enum: ENUMS.colorMode.slice() }, description: 'Color modes the product is sold in.' },
          clipEligible: { type: 'boolean', description: 'True when the product hangs with roofline clips.' },
          enabled: { type: 'boolean', description: 'False hides the product from auto-planning.' },
          suitableFor: { type: 'array', items: { type: 'string' }, description: 'Feature types the planner may pick it for.' },
          notes: { type: 'string', description: 'Free text shown in the library editor.' },
          supplierId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Supplier this product is from ("cle", "1000bulbs"); missing = any store. Supplier product ids are "<supplierId>:<name>".' },
          supplierSku: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The part number to type at the supplier; null = not confirmed, order from the link.' },
          url: { anyOf: [{ type: 'string', pattern: '^https://' }, { type: 'null' }], description: 'Product page at the supplier (https only).' },
          priceAsOf: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Day the price was seen (YYYY-MM-DD).' },
          priceStatus: { enum: ENUMS.priceStatus.slice(), description: 'verified = seen on the supplier\'s page that day; observed = seen in a search result, not confirmed.' },
          equiv: { type: 'string', description: 'Id of the generic product whose job this one does, e.g. "c9-led": the planner swaps it in when the project buys from this supplier.' },
          kind: { anyOf: [{ enum: ENUMS.productKind.slice() }, { type: 'null' }], description: 'bulk = socket wire cut to length + bulbs + plugs, planned per foot (unit "foot"). Missing or null = a ready-made product.' },
          components: { anyOf: [ref('bulkComponents'), { type: 'null' }], description: 'Bulk only: the parts it is bought as (wire, bulbs, plugs).' },
          maxRunFt: { type: 'number', exclusiveMinimum: 0, description: 'Bulk: longest single run in feet (default 250).' },
          maxBulbsPerRun: { type: 'number', exclusiveMinimum: 0, description: 'Bulk: most bulbs on one run (default 250).' },
          maxConnectedW: { type: 'number', exclusiveMinimum: 0, description: 'Most watts this product\'s wiring may carry end to end, its own lights plus whatever is plugged into its end. Default maxEndToEnd x wattsPerUnit.' },
          endConnector: { type: 'boolean', description: 'True when another run or a jumper cord can plug into its end. Default false only for unit "foot".' },
          orderNote: { type: 'string', description: 'A short caution printed on the BOM line (for example which size to pick on a page that lists several).' },
        },
      },
      pricing: {
        type: 'object', required: ['overrides'],
        description: 'Price overrides.',
        properties: {
          overrides: { type: 'object', additionalProperties: { type: 'number', minimum: 0 }, description: 'SKU → unit price in USD, replacing the library price in the BOM.' },
        },
      },
      quote: {
        type: 'object', required: ['enabled', 'company', 'laborMethod', 'ratePerFt', 'ratePerHour', 'markupPct', 'takedownFee', 'storageFee', 'taxPct', 'validDays', 'notes'],
        description: 'Installer mode: settings for the customer quote.',
        properties: {
          enabled: { type: 'boolean', description: 'True when installer mode (quote) is on.' },
          company: { type: 'string', description: 'Installer company name printed on the quote.' },
          laborMethod: { enum: ENUMS.laborMethod.slice(), description: 'perFt (charge per installed foot plus hourly trees and bushes) or perHour (charge the estimated hours).' },
          ratePerFt: { type: 'number', minimum: 0, description: 'Labor price per installed foot (USD).' },
          ratePerHour: { type: 'number', minimum: 0, description: 'Labor price per hour (USD).' },
          markupPct: { type: 'number', minimum: 0, description: 'Percent added to the materials cost.' },
          takedownFee: { type: 'number', minimum: 0, description: 'Flat fee for taking the lights down after the season (USD).' },
          storageFee: { type: 'number', minimum: 0, description: 'Flat fee for storing the lights until next season (USD).' },
          taxPct: { type: 'number', minimum: 0, maximum: 100, description: 'Sales tax percent applied to the marked-up materials.' },
          validDays: { type: 'integer', minimum: 0, description: 'Days the quote stays valid.' },
          notes: { type: 'string', description: 'Free text printed at the bottom of the quote.' },
        },
      },
      exportFile: {
        type: 'object', required: ['schema', 'version', 'exportedAt', 'project', 'images', 'derived'],
        description: 'JSON export wrapper written by schema.exportProject and read by schema.importProject.',
        properties: {
          schema: { const: EXPORT_SCHEMA_ID, description: 'Always "lightplan/export".' },
          version: { const: EXPORT_VERSION, description: 'Export wrapper version.' },
          exportedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'When the file was written (ISO 8601).' },
          project: { $ref: '#', description: 'The persisted project.' },
          images: { type: 'object', additionalProperties: { type: 'string' }, description: 'storageKey → image data URL ("data:image/jpeg;base64,..."). Empty when exported without photos.' },
          derived: { anyOf: [ref('derivedPlan'), { type: 'null' }], description: 'Recomputed plan at export time, for Phase 2 consumers. Never read back on import.' },
        },
      },
      derivedPlan: {
        type: 'object',
        description: 'Output of plan.computePlan (loosely typed; recomputed from the project, so it is informative only).',
        properties: {
          library: { type: 'object', description: 'Effective products, config and accessories.' },
          measured: { type: 'object', description: 'measure.measureProject result: cameras, plane solutions, pitch, per-feature measurements, totals, warnings.' },
          runs: { type: 'array', items: { type: 'object' }, description: 'Light runs with products, quantities, watts, clips and power assignment.' },
          power: { type: 'object', description: 'Chains, feeds, outlets, circuits, cords, counts, totals and warnings.' },
          bom: { type: 'object', description: 'Bill of materials lines, subtotal and totals by category.' },
          quote: { type: 'object', description: 'Customer quote lines and totals.' },
          checklist: { type: 'array', items: { type: 'object' }, description: 'Install checklist groups.' },
          warnings: { type: 'array', items: { type: 'object' }, description: 'All warnings, most severe first.' },
          summary: { type: 'object', description: 'Headline numbers: feet, strings, clips, cords, timers, watts, cost.' },
        },
      },
    },
  };

  // ================================================================ small coercion helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

  /** Finite number (numeric strings accepted) within [min, max], else the default. */
  function num(v, def, min, max) {
    let n = v;
    if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) n = Number(n);
    if (typeof n !== 'number' || !Number.isFinite(n)) return def;
    if (min !== undefined && n < min) return def;
    if (max !== undefined && n > max) return def;
    return n;
  }
  /** Positive finite number or null. */
  const posOrNull = (v) => { const n = num(v, null); return n !== null && n > 0 ? n : null; };
  const intOr = (v, def, min) => { const n = num(v, null, min); return n !== null && Number.isInteger(n) ? n : def; };
  const str = (v, def) => (typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : def));
  const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const isHex = (c) => typeof c === 'string' && HEX_RE.test(c);
  const isPoint = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  /** [x, y] from an array or {x, y}; null when not two finite numbers. */
  function toPoint(p) {
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0], p[1]];
    if (isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) return [p.x, p.y];
    return null;
  }
  const toPoints = (list) => arr(list).map(toPoint).filter(Boolean);
  function isoOrNull(v) {
    if (typeof v === 'string' && v.trim()) return v;
    if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
    return null;
  }
  /** JSON deep clone; undefined when the value cannot be represented as JSON. */
  function jsonClone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return undefined; }
  }
  /** Copy keys of `raw` that the normalizer does not know about (deep-cloned) onto `out`. Values that are
   *  not JSON (functions such as a factory's opts.rng) are skipped. */
  function keepExtras(out, raw, known) {
    if (!isObj(raw)) return out;
    for (const k of Object.keys(raw)) {
      if (known.includes(k) || has(out, k)) continue;
      const v = jsonClone(raw[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  function normPitch(v) {
    if (!isObj(v)) return null;
    const rise = num(v.rise, null, 0);
    const run = num(v.run, 12);
    if (rise === null || !(run > 0)) return null;
    return { rise, run };
  }

  /** Random id: prefix + "_" + 8 base-36 characters. rng is an optional () => [0, 1) generator. */
  function uid(prefix, rng) {
    const next = typeof rng === 'function' ? rng : Math.random;
    const p = String(prefix == null || prefix === '' ? 'id' : prefix).replace(/_+$/, '');
    let s = '';
    for (let i = 0; i < 8; i++) {
      let k = Math.floor(Number(next()) * 36);
      if (!(k >= 0 && k < 36)) k = 0;
      s += ID_ALPHABET[k];
    }
    return p + '_' + s;
  }

  /**
   * Deterministic id assignment for one entity kind: keeps each valid, unused id; replaces missing or
   * duplicate ids with prefix_N (N from the item's position, bumped until free).
   */
  function idPool(prefix, rawItems) {
    const original = new Set();
    for (const it of rawItems) { const id = cleanId(isObj(it) ? it.id : null); if (id) original.add(id); }
    const taken = new Set();
    return function assign(rawId, index) {
      const id = cleanId(rawId);
      if (id && !taken.has(id)) { taken.add(id); return id; }
      let n = index + 1;
      let cand = prefix + '_' + n;
      while (taken.has(cand) || original.has(cand)) { n += 1; cand = prefix + '_' + n; }
      taken.add(cand);
      return cand;
    };
  }
  function cleanId(v) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  }
  const freshId = (opts, kind) => cleanId(opts.id) || uid(ID_PREFIX[kind], opts.rng);

  // ================================================================ per-entity normalizers
  // Each takes raw input and an already-decided id and returns an object with every field set.

  function createDefaultSettings() {
    return { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: ['#ff3b30', '#34c759'], lengthFormat: 'ft-in' };
  }
  function normSettings(raw) {
    const d = createDefaultSettings();
    const s = isObj(raw) ? raw : {};
    const colors = Array.isArray(s.customColors) ? s.customColors.filter(isHex) : d.customColors;
    return keepExtras({
      wastePct: num(s.wastePct, d.wastePct, 0, 100),
      roofPitch: has(s, 'roofPitch') ? normPitch(s.roofPitch) : d.roofPitch,
      colorMode: oneOf(s.colorMode, ENUMS.colorMode, d.colorMode),
      customColors: colors,
      lengthFormat: oneOf(s.lengthFormat, ENUMS.lengthFormat, d.lengthFormat),
    }, s, []);
  }
  function normCustomer(raw) {
    const c = isObj(raw) ? raw : {};
    return keepExtras({ name: str(c.name, ''), address: str(c.address, ''), phone: str(c.phone, ''), email: str(c.email, '') }, c, []);
  }
  function createDefaultQuote() {
    return { enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30,
      takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '' };
  }
  function normQuote(raw) {
    const d = createDefaultQuote();
    const q = isObj(raw) ? raw : {};
    return keepExtras({
      enabled: bool(q.enabled, d.enabled),
      company: str(q.company, d.company),
      laborMethod: oneOf(q.laborMethod, ENUMS.laborMethod, d.laborMethod),
      ratePerFt: num(q.ratePerFt, d.ratePerFt, 0),
      ratePerHour: num(q.ratePerHour, d.ratePerHour, 0),
      markupPct: num(q.markupPct, d.markupPct, 0),
      takedownFee: num(q.takedownFee, d.takedownFee, 0),
      storageFee: num(q.storageFee, d.storageFee, 0),
      taxPct: num(q.taxPct, d.taxPct, 0, 100),
      validDays: intOr(q.validDays, d.validDays, 0),
      notes: str(q.notes, d.notes),
    }, q, []);
  }
  /**
   * Plain reason a quote field value would be rewritten by normalizeProject (so the UI can refuse it up front
   * and the app never holds a value that a reload or import would silently reset), or null when it is kept.
   */
  function quoteFieldProblem(field, value) {
    const d = createDefaultQuote();
    if (!has(d, field)) return null;
    const kept = normQuote(Object.assign(d, { [field]: value }))[field];
    if (kept === value) return null;
    if (field === 'taxPct') return 'Tax must be a percentage from 0 to 100.';
    if (field === 'validDays') return 'Enter a whole number of days, 0 or more.';
    if (typeof d[field] === 'number') return 'Enter a number of 0 or more.';
    return 'That value cannot be used for the quote.';
  }
  /** A link is kept only when it is a plain https address (suppliers.safeUrl): product data can come from a file. */
  function cleanUrl(obj) {
    if (isObj(obj) && has(obj, 'url') && obj.url !== null && suppliers.safeUrl(obj.url) === null) delete obj.url;
  }
  /** Supplier fields of a product (SPEC §8.3) are kept as they are, except unsafe links and unknown price statuses. */
  function cleanSupplierFields(p) {
    cleanUrl(p);
    if (has(p, 'priceStatus') && !ENUMS.priceStatus.includes(p.priceStatus)) delete p.priceStatus;
    for (const c of suppliers.componentOffers(p)) {
      cleanUrl(c.offer);
      if (has(c.offer, 'priceStatus') && !ENUMS.priceStatus.includes(c.offer.priceStatus)) delete c.offer.priceStatus;
    }
  }
  function normLibrary(raw) {
    const l = isObj(raw) ? raw : {};
    const products = Array.isArray(l.products) ? l.products.filter((p) => isObj(p) && cleanId(p.id)).map(jsonClone).filter(Boolean) : [];
    for (const p of products) { p.id = cleanId(p.id); cleanSupplierFields(p); }
    const config = isObj(l.config) ? jsonClone(l.config) : null;
    if (isObj(config) && has(config, 'buying')) {
      // Phase 1.1: how C7/C9 is bought. A value that is not a known word is dropped so the default applies.
      if (!isObj(config.buying)) delete config.buying;
      else {
        if (has(config.buying, 'style') && !ENUMS.buyingStyle.includes(config.buying.style)) delete config.buying.style;
        if (has(config.buying, 'costBasis') && !ENUMS.costBasis.includes(config.buying.costBasis)) delete config.buying.costBasis;
      }
    }
    const out = { products: products.length ? products : null, config: isObj(config) ? config : null };
    // Phase 1.1: optional, so projects saved before it are still normalized as they are. Missing means any store.
    if (has(l, 'supplierId')) out.supplierId = cleanId(typeof l.supplierId === 'string' ? l.supplierId : null);
    return keepExtras(out, l, ['supplierId']);
  }
  /**
   * tapErr (SPEC §8.4) beside a point list: the list itself when it is finite numbers of 0 or more, one per
   * point, else undefined (dropped: no information). `rawPointCount` guards against a point list that lost
   * points in normalization, which would leave the errors out of step.
   */
  function normTapErr(v, pointCount, rawPointCount) {
    if (!Array.isArray(v) || v.length !== pointCount || pointCount === 0 || rawPointCount !== pointCount) return undefined;
    return v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) ? v.slice() : undefined;
  }
  /** Sets out.tapErr when raw.tapErr is valid for `points`; never adds one. */
  function keepTapErr(out, raw, points, rawPoints) {
    const t = has(raw, 'tapErr') ? normTapErr(raw.tapErr, points ? points.length : 0, Array.isArray(rawPoints) ? rawPoints.length : -1) : undefined;
    if (t) out.tapErr = t;
    return out;
  }
  function normPricing(raw) {
    const p = isObj(raw) ? raw : {};
    const overrides = {};
    if (isObj(p.overrides)) {
      for (const sku of Object.keys(p.overrides)) {
        const v = num(p.overrides[sku], null, 0);
        if (v !== null && sku) overrides[sku] = v;
      }
    }
    return keepExtras({ overrides }, p, []);
  }

  const IMAGE_KEYS = ['id', 'name', 'width', 'height', 'source', 'exif', 'camera', 'storageKey'];
  function normImage(raw, id) {
    const im = isObj(raw) ? raw : {};
    const src = isObj(im.source) ? im.source : {};
    const cam = isObj(im.camera) ? im.camera : {};
    let exif = null;
    if (isObj(im.exif)) {
      const e = im.exif;
      exif = { focal35: posOrNull(e.focal35), focalMm: posOrNull(e.focalMm), make: strOrNull(e.make), model: strOrNull(e.model) };
      if (has(e, 'orientation')) exif.orientation = intOr(e.orientation, null, 1);
      if (has(e, 'width')) exif.width = posOrNull(e.width);
      if (has(e, 'height')) exif.height = posOrNull(e.height);
      if (has(e, 'dateTime')) exif.dateTime = strOrNull(e.dateTime);
      keepExtras(exif, e, ['orientation', 'width', 'height', 'dateTime']);
    }
    const out = {
      id,
      name: str(im.name, ''),
      width: posOrNull(im.width),
      height: posOrNull(im.height),
      source: keepExtras({
        kind: oneOf(src.kind, ENUMS.sourceKind, 'upload'),
        capturedAt: strOrNull(src.capturedAt),
        attribution: strOrNull(src.attribution),
      }, src, []),
      exif,
      camera: keepExtras({
        mode: oneOf(cam.mode, ENUMS.cameraMode, 'auto'),
        presetId: has(cam, 'presetId') ? strOrNull(cam.presetId) : 'phone1x',
        focalPx: posOrNull(cam.focalPx),
      }, cam, []),
      storageKey: typeof im.storageKey === 'string' && im.storageKey ? im.storageKey : (im.storageKey === null ? null : id),
    };
    return keepExtras(out, im, IMAGE_KEYS);
  }

  const REF_KEYS = ['id', 'kind', 'points', 'lengthFt', 'courses', 'widthFt', 'heightFt', 'presetId', 'quality', 'tapErr'];
  /** Calibration ref, or null when its points do not fit its kind (2 for a line, 4 for a rect). */
  function normRef(raw, id) {
    const r = isObj(raw) ? raw : {};
    const points = toPoints(r.points);
    const kind = oneOf(r.kind, ENUMS.refKind, points.length === 4 ? 'rect' : 'line');
    if ((kind === 'line' && points.length !== 2) || (kind === 'rect' && points.length !== 4)) return null;
    const base = { id, kind, points };
    if (kind === 'rect') {
      Object.assign(base, { widthFt: posOrNull(r.widthFt), heightFt: posOrNull(r.heightFt) });
    } else {
      Object.assign(base, { lengthFt: posOrNull(r.lengthFt), courses: intOr(r.courses, null, 1) });
    }
    base.presetId = strOrNull(r.presetId);
    base.quality = oneOf(r.quality, ENUMS.quality, 'high');
    keepTapErr(base, r, points, r.points);
    return keepExtras(base, r, REF_KEYS);
  }

  const PLANE_KEYS = ['id', 'imageId', 'name', 'kind', 'color', 'rect', 'refs', 'derived'];
  function normPlane(raw, id, index, refIdFor) {
    const pl = isObj(raw) ? raw : {};
    const kind = oneOf(pl.kind, ENUMS.planeKind, 'wall');
    let rect = null;
    if (isObj(pl.rect)) {
      const corners = toPoints(pl.rect.corners);
      if (corners.length === 4) {
        rect = keepExtras(keepTapErr({ corners, widthFt: posOrNull(pl.rect.widthFt), heightFt: posOrNull(pl.rect.heightFt), presetId: strOrNull(pl.rect.presetId) },
          pl.rect, corners, pl.rect.corners), pl.rect, ['tapErr']);
      }
    }
    const refs = [];
    arr(pl.refs).forEach((r, i) => {
      const nr = normRef(r, refIdFor(isObj(r) ? r.id : null, i));
      if (nr) refs.push(nr);
    });
    let derived = null;
    if (kind !== 'wall' && isObj(pl.derived)) {
      const line = toPoints(pl.derived.line);
      derived = keepExtras(keepTapErr({
        parentPlaneId: cleanId(pl.derived.parentPlaneId),
        line: line.length === 2 ? line : null,
        pitch: normPitch(pl.derived.pitch),
      }, pl.derived, line.length === 2 ? line : null, pl.derived.line), pl.derived, ['tapErr']);
    }
    const defaultName = kind === 'wall' ? 'Wall ' + (index + 1) : kind === 'roof' ? 'Roof' : 'Ground';
    const out = {
      id,
      imageId: cleanId(pl.imageId),
      name: str(pl.name, defaultName),
      kind,
      color: isHex(pl.color) ? pl.color : PLANE_COLORS[kind],
      rect,
      refs,
      derived,
    };
    return keepExtras(out, pl, PLANE_KEYS);
  }

  const PARAM_KEYS = ['mount', 'diameterIn', 'spiralSpacingIn', 'wrapMode', 'outletId', 'reverse', 'ownCord', 'overrideWidthFt', 'overrideHeightFt'];
  function normParams(raw) {
    const p = isObj(raw) ? raw : {};
    const out = {
      mount: oneOf(p.mount, ENUMS.mount, null),
      diameterIn: posOrNull(p.diameterIn),
      spiralSpacingIn: posOrNull(p.spiralSpacingIn),
      wrapMode: oneOf(p.wrapMode, ENUMS.wrapMode, null),
      outletId: cleanId(p.outletId),
      reverse: bool(p.reverse, false),
      overrideWidthFt: posOrNull(p.overrideWidthFt),
      overrideHeightFt: posOrNull(p.overrideHeightFt),
    };
    // Phase 1.1: optional, so projects saved before it are still normalized as they are. Missing means false.
    if (typeof p.ownCord === 'boolean') out.ownCord = p.ownCord;
    return keepExtras(out, p, PARAM_KEYS);
  }
  function normFeatureColor(raw) {
    if (!isObj(raw) || !ENUMS.colorMode.includes(raw.mode)) return null;
    const out = { mode: raw.mode };
    if (raw.mode === 'custom' || Array.isArray(raw.colors)) out.colors = arr(raw.colors).filter(isHex);
    return keepExtras(out, raw, ['colors']);
  }

  const FEATURE_KEYS = ['id', 'imageId', 'planeId', 'type', 'label', 'points', 'closed', 'overrideFt', 'productId', 'color', 'params', 'tapErr'];
  function normFeature(raw, id) {
    const f = isObj(raw) ? raw : {};
    const type = typeof f.type === 'string' ? f.type : '';
    const ft = catalog.FEATURE_TYPES[type];
    const out = {
      id,
      imageId: cleanId(f.imageId),
      planeId: cleanId(f.planeId),
      type,
      label: str(f.label, ft ? ft.label : ''),
      points: toPoints(f.points),
      closed: bool(f.closed, ft ? !!ft.closedDefault : false),
      overrideFt: posOrNull(f.overrideFt),
      productId: strOrNull(f.productId),
      color: normFeatureColor(f.color),
      params: normParams(f.params),
    };
    keepTapErr(out, f, out.points, f.points);
    return keepExtras(out, f, FEATURE_KEYS);
  }

  const OUTLET_KEYS = ['id', 'imageId', 'planeId', 'point', 'label', 'type', 'gfci', 'circuitId', 'receptacles'];
  function normOutlet(raw, id) {
    const o = isObj(raw) ? raw : {};
    const type = oneOf(o.type, ENUMS.outletType, 'exteriorGfci');
    const out = {
      id,
      imageId: cleanId(o.imageId),
      planeId: cleanId(o.planeId),
      point: toPoint(o.point),
      label: str(o.label, 'Outlet'),
      type,
      gfci: bool(o.gfci, type === 'exteriorGfci'),
      circuitId: cleanId(o.circuitId),
      receptacles: intOr(o.receptacles, 2, 1),
    };
    return keepExtras(out, o, OUTLET_KEYS);
  }

  const CIRCUIT_KEYS = ['id', 'name', 'breakerAmps', 'voltage', 'existingLoadW'];
  function normCircuit(raw, id, index) {
    const c = isObj(raw) ? raw : {};
    const out = {
      id,
      name: str(c.name, 'Circuit ' + (index + 1)),
      breakerAmps: num(c.breakerAmps, 15) > 0 ? num(c.breakerAmps, 15) : 15,
      voltage: num(c.voltage, 120) > 0 ? num(c.voltage, 120) : 120,
      existingLoadW: num(c.existingLoadW, 0, 0),
    };
    return keepExtras(out, c, CIRCUIT_KEYS);
  }

  // ================================================================ factories (§5.9)
  function createCircuit(opts) {
    const o = isObj(opts) ? opts : {};
    return normCircuit(Object.assign({ name: 'Circuit 1' }, o), freshId(o, 'circuit'), 0);
  }
  function createImage(opts) {
    const o = isObj(opts) ? opts : {};
    return normImage(o, freshId(o, 'image'));
  }
  function createRef(opts) {
    const o = isObj(opts) ? opts : {};
    const id = freshId(o, 'ref');
    const r = normRef(o, id);
    if (r) return r;
    // Not enough points yet: still return a complete object of the requested kind.
    const kind = oneOf(o.kind, ENUMS.refKind, 'line');
    const base = { id, kind, points: toPoints(o.points) };
    if (kind === 'rect') Object.assign(base, { widthFt: posOrNull(o.widthFt), heightFt: posOrNull(o.heightFt) });
    else Object.assign(base, { lengthFt: posOrNull(o.lengthFt), courses: intOr(o.courses, null, 1) });
    base.presetId = strOrNull(o.presetId);
    base.quality = oneOf(o.quality, ENUMS.quality, 'high');
    return base;
  }
  function createPlane(opts) {
    const o = isObj(opts) ? opts : {};
    const pl = normPlane(o, freshId(o, 'plane'), 0, (rawId) => cleanId(rawId) || uid(ID_PREFIX.ref, o.rng));
    if (!has(o, 'name')) pl.name = pl.kind === 'wall' ? 'Wall' : pl.kind === 'roof' ? 'Roof' : 'Ground';
    // Roof and ground planes always carry a derived block, filled from opts.derived when given.
    if (pl.kind !== 'wall' && !pl.derived) pl.derived = { parentPlaneId: null, line: null, pitch: null };
    return pl;
  }
  function createFeature(type, opts) {
    if (!catalog.FEATURE_TYPES[type]) throw new Error('Unknown feature type "' + type + '".');
    const o = isObj(opts) ? opts : {};
    return normFeature(Object.assign({}, o, { type }), freshId(o, 'feature'));
  }
  function createOutlet(opts) {
    const o = isObj(opts) ? opts : {};
    return normOutlet(o, freshId(o, 'outlet'));
  }
  /**
   * New empty project: no images, planes, features or outlets, one 15 A circuit. opts may set name,
   * customer, settings, quote, id, rng, and now / createdAt / updatedAt (ISO strings).
   */
  function createProject(opts) {
    const o = isObj(opts) ? opts : {};
    const createdAt = isoOrNull(o.createdAt) || isoOrNull(o.now);
    return {
      schema: SCHEMA_ID,
      version: SCHEMA_VERSION,
      id: freshId(o, 'project'),
      name: str(o.name, ''),
      createdAt,
      updatedAt: isoOrNull(o.updatedAt) || createdAt,
      customer: normCustomer(o.customer),
      settings: normSettings(o.settings),
      images: [],
      activeImageId: null,
      planes: [],
      features: [],
      outlets: [],
      circuits: [createCircuit({ name: 'Circuit 1', breakerAmps: 15, rng: o.rng })],
      library: { products: null, config: null },
      pricing: { overrides: {} },
      quote: normQuote(o.quote),
    };
  }

  // ================================================================ normalizeProject
  const PROJECT_KEYS = ['schema', 'version', 'id', 'name', 'createdAt', 'updatedAt', 'customer', 'settings', 'images',
    'activeImageId', 'planes', 'features', 'outlets', 'circuits', 'library', 'pricing', 'quote', 'derived'];

  /**
   * Complete, consistent copy of a (possibly partial or damaged) project. Never throws and never mutates
   * its input. Call migrateProject first for data from older versions.
   */
  function normalizeProject(p) {
    try {
      return normalizeUnsafe(p);
    } catch (e) {
      // Only reachable for hostile input (e.g. throwing getters). Return a valid empty project.
      const fallback = createProject({ id: 'prj_recovered', rng: geometry.rng(1) });
      fallback.circuits[0].id = 'cir_1';
      return fallback;
    }
  }

  function normalizeUnsafe(p) {
    const raw = isObj(p) ? p : {};
    const rawImages = arr(raw.images).filter(isObj);
    const rawPlanes = arr(raw.planes).filter(isObj);
    const rawFeatures = arr(raw.features).filter(isObj);
    const rawOutlets = arr(raw.outlets).filter(isObj);
    const rawCircuits = raw.circuits === undefined ? [{ id: 'cir_1', name: 'Circuit 1', breakerAmps: 15 }] : arr(raw.circuits).filter(isObj);

    const imgId = idPool(ID_PREFIX.image, rawImages);
    const images = rawImages.map((im, i) => normImage(im, imgId(im.id, i)));
    const imageIds = new Set(images.map((im) => im.id));
    const activeImageId = imageIds.has(cleanId(raw.activeImageId)) ? cleanId(raw.activeImageId) : (images[0] ? images[0].id : null);
    const resolveImage = (id, fallback) => (imageIds.has(id) ? id : (imageIds.has(fallback) ? fallback : activeImageId));

    const cirId = idPool(ID_PREFIX.circuit, rawCircuits);
    const circuits = rawCircuits.map((c, i) => normCircuit(c, cirId(c.id, i), i));
    const circuitIds = new Set(circuits.map((c) => c.id));

    const allRefs = [];
    for (const pl of rawPlanes) for (const r of arr(pl.refs)) allRefs.push(r);
    const refId = idPool(ID_PREFIX.ref, allRefs);
    let refCounter = 0;
    const plId = idPool(ID_PREFIX.plane, rawPlanes);
    const planes = rawPlanes.map((pl, i) => normPlane(pl, plId(pl.id, i), i, (rid) => refId(rid, refCounter++)));
    const planeById = new Map(planes.map((pl) => [pl.id, pl]));
    for (const pl of planes) {
      pl.imageId = resolveImage(pl.imageId, null);
      if (pl.derived && !(planeById.has(pl.derived.parentPlaneId) && pl.derived.parentPlaneId !== pl.id)) pl.derived.parentPlaneId = null;
    }
    const planeImage = (planeId) => (planeById.has(planeId) ? planeById.get(planeId).imageId : null);

    const outId = idPool(ID_PREFIX.outlet, rawOutlets);
    const outlets = rawOutlets.map((o, i) => {
      const out = normOutlet(o, outId(o.id, i));
      if (!planeById.has(out.planeId)) out.planeId = null;
      out.imageId = resolveImage(out.imageId, planeImage(out.planeId));
      if (!circuitIds.has(out.circuitId)) out.circuitId = null;
      return out;
    });
    const outletIds = new Set(outlets.map((o) => o.id));

    const ftId = idPool(ID_PREFIX.feature, rawFeatures);
    const features = rawFeatures.map((f, i) => {
      const out = normFeature(f, ftId(f.id, i));
      if (!planeById.has(out.planeId)) out.planeId = null;
      out.imageId = resolveImage(out.imageId, planeImage(out.planeId));
      if (!outletIds.has(out.params.outletId)) out.params.outletId = null;
      return out;
    });

    const createdAt = isoOrNull(raw.createdAt);
    const project = {
      schema: SCHEMA_ID,
      version: SCHEMA_VERSION,
      id: cleanId(raw.id) || 'prj_' + geometry.hashString(stableText(raw)).toString(36),
      name: str(raw.name, ''),
      createdAt,
      updatedAt: isoOrNull(raw.updatedAt) || createdAt,
      customer: normCustomer(raw.customer),
      settings: normSettings(raw.settings),
      images,
      activeImageId,
      planes,
      features,
      outlets,
      circuits,
      library: normLibrary(raw.library),
      pricing: normPricing(raw.pricing),
      quote: normQuote(raw.quote),
    };
    return keepExtras(project, raw, PROJECT_KEYS);
  }
  /** Text used to derive a stable id for a project that has none. */
  function stableText(raw) {
    try { return JSON.stringify(raw) || 'project'; } catch (e) { return 'project'; }
  }

  // ================================================================ migration
  /**
   * Upgraders keyed by the version they upgrade FROM. Each takes a deep-cloned project of that version
   * and returns the next version. Version 1 is current, so there are none yet. Example for the future:
   *   1: (p) => { p.settings.currency = 'USD'; p.version = 2; return p; }
   */
  const MIGRATIONS = {};

  function migrateProject(p) {
    if (!isObj(p)) throw new Error(NOT_A_PROJECT);
    if (p.schema !== undefined && p.schema !== SCHEMA_ID) throw new Error(NOT_A_PROJECT);
    let v = p.version;
    if (v === undefined || v === null) v = 1; // drafts saved before the version field existed
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (!Number.isInteger(v) || v < 1) {
      throw new Error('This project has an unknown format version (' + String(p.version) + '), so it cannot be opened.');
    }
    if (v > SCHEMA_VERSION) {
      throw new Error('This project was saved by a newer version of LightPlan (format version ' + v + '). Update LightPlan to open it.');
    }
    let out = jsonClone(p);
    if (!isObj(out)) throw new Error('This project could not be read because its data is damaged.');
    while (v < SCHEMA_VERSION) {
      const step = MIGRATIONS[v];
      if (typeof step !== 'function') throw new Error('This project uses format version ' + v + ', which this version of LightPlan cannot upgrade.');
      out = step(out);
      v += 1;
    }
    out.schema = SCHEMA_ID;
    out.version = SCHEMA_VERSION;
    return out;
  }

  // ================================================================ validation
  /** Checks a project against the data model. Returns {ok, errors: [plain sentences]}. Never throws. */
  function validateProject(p) {
    const errors = [];
    try {
      validateInto(p, errors);
    } catch (e) {
      errors.push('The project data could not be checked because it is damaged.');
    }
    return { ok: errors.length === 0, errors };
  }

  function validateInto(p, errors) {
    const err = (m) => { if (errors.length < 200) errors.push(m); };
    if (!isObj(p)) { err('This is not a LightPlan project: expected an object.'); return; }
    if (p.schema !== SCHEMA_ID) err('The "schema" field must be "' + SCHEMA_ID + '".');
    if (p.version !== SCHEMA_VERSION) err('Format version ' + JSON.stringify(p.version) + ' is not supported (expected ' + SCHEMA_VERSION + ').');
    if (!cleanId(p.id) || typeof p.id !== 'string') err('The project has no id.');
    if (typeof p.name !== 'string') err('The project name must be text.');
    for (const k of ['createdAt', 'updatedAt']) if (p[k] !== null && typeof p[k] !== 'string') err('"' + k + '" must be a date string or null.');

    if (!isObj(p.customer)) err('Customer details are missing.');
    else for (const k of ['name', 'address', 'phone', 'email']) if (typeof p.customer[k] !== 'string') err('Customer ' + k + ' must be text.');

    const s = p.settings;
    if (!isObj(s)) err('Settings are missing.');
    else {
      if (!(typeof s.wastePct === 'number' && s.wastePct >= 0 && s.wastePct <= 100)) err('Waste must be a percentage from 0 to 100.');
      if (s.roofPitch !== null && !validPitch(s.roofPitch)) err('The project roof pitch must be a rise and run (for example 6/12) or empty.');
      if (!ENUMS.colorMode.includes(s.colorMode)) err('The color mode ' + JSON.stringify(s.colorMode) + ' is not one of ' + ENUMS.colorMode.join(', ') + '.');
      if (!Array.isArray(s.customColors) || !s.customColors.every(isHex)) err('Custom colors must be a list of hex colors like "#ff3b30".');
      if (!ENUMS.lengthFormat.includes(s.lengthFormat)) err('The length format must be "ft-in" or "ft-decimal".');
    }

    const lists = {};
    for (const k of ['images', 'planes', 'features', 'outlets', 'circuits']) {
      lists[k] = Array.isArray(p[k]) ? p[k] : null;
      if (!lists[k]) err('The "' + k + '" list is missing.');
    }
    const ids = (list) => new Set(arr(list).filter(isObj).map((x) => x.id).filter((id) => typeof id === 'string'));
    const imageIds = ids(lists.images), planeIds = ids(lists.planes), outletIds = ids(lists.outlets), circuitIds = ids(lists.circuits);
    const dupCheck = (list, noun) => {
      const seen = new Set();
      for (const x of arr(list)) {
        if (!isObj(x) || typeof x.id !== 'string') continue;
        if (seen.has(x.id)) err('Two ' + noun + ' share the id "' + x.id + '".');
        seen.add(x.id);
      }
    };
    const refOk = (v, set) => v === null || (typeof v === 'string' && set.has(v));
    const name = (noun, x, i) => {
      const label = isObj(x) && typeof x.label === 'string' && x.label ? x.label : (isObj(x) && typeof x.name === 'string' && x.name ? x.name : null);
      const id = isObj(x) && typeof x.id === 'string' && x.id ? x.id : null;
      return noun + ' ' + (label ? '"' + label + '"' : id ? '"' + id + '"' : '#' + (i + 1));
    };

    arr(lists.images).forEach((im, i) => {
      const who = name('Image', im, i);
      if (!isObj(im)) { err(who + ' is not an object.'); return; }
      if (!cleanId(im.id) || typeof im.id !== 'string') err(who + ' has no id.');
      if (typeof im.name !== 'string') err(who + ': the file name must be text.');
      if (!(typeof im.width === 'number' && im.width > 0) || !(typeof im.height === 'number' && im.height > 0)) err(who + ' has no valid width and height.');
      if (!isObj(im.source) || !ENUMS.sourceKind.includes(im.source.kind)) err(who + ': the source must be one of ' + ENUMS.sourceKind.join(', ') + '.');
      if (im.exif !== null && !isObj(im.exif)) err(who + ': EXIF data must be an object or null.');
      if (!isObj(im.camera) || !ENUMS.cameraMode.includes(im.camera.mode)) err(who + ': the camera mode must be one of ' + ENUMS.cameraMode.join(', ') + '.');
      else if (im.camera.focalPx !== null && !(typeof im.camera.focalPx === 'number' && im.camera.focalPx > 0)) err(who + ': the manual focal length must be a positive number.');
      if (im.storageKey !== null && typeof im.storageKey !== 'string') err(who + ': the storage key must be text.');
    });
    dupCheck(lists.images, 'images');
    if (!(p.activeImageId === null || imageIds.has(p.activeImageId))) err('The active image does not exist.');

    arr(lists.circuits).forEach((c, i) => {
      const who = name('Circuit', c, i);
      if (!isObj(c)) { err(who + ' is not an object.'); return; }
      if (!cleanId(c.id) || typeof c.id !== 'string') err(who + ' has no id.');
      if (typeof c.name !== 'string') err(who + ': the name must be text.');
      if (!(typeof c.breakerAmps === 'number' && c.breakerAmps > 0)) err(who + ': the breaker size must be a positive number of amps.');
      if (!(typeof c.voltage === 'number' && c.voltage > 0)) err(who + ': the voltage must be a positive number.');
      if (!(typeof c.existingLoadW === 'number' && c.existingLoadW >= 0)) err(who + ': the existing load must be zero or more watts.');
    });
    dupCheck(lists.circuits, 'circuits');

    const refSeen = new Set();
    arr(lists.planes).forEach((pl, i) => {
      const who = name('Plane', pl, i);
      if (!isObj(pl)) { err(who + ' is not an object.'); return; }
      if (!cleanId(pl.id) || typeof pl.id !== 'string') err(who + ' has no id.');
      if (!refOk(pl.imageId, imageIds)) err(who + ' is on a photo that does not exist.');
      if (typeof pl.name !== 'string') err(who + ': the name must be text.');
      if (!ENUMS.planeKind.includes(pl.kind)) err(who + ': the kind must be wall, roof or ground.');
      if (!isHex(pl.color)) err(who + ': the color must be a hex color.');
      if (pl.rect !== null) {
        if (!isObj(pl.rect) || !Array.isArray(pl.rect.corners) || pl.rect.corners.length !== 4 || !pl.rect.corners.every(isPoint)) err(who + ': the rectangle needs exactly 4 corner points.');
        else for (const k of ['widthFt', 'heightFt']) if (pl.rect[k] !== null && !(typeof pl.rect[k] === 'number' && pl.rect[k] > 0)) err(who + ': the rectangle ' + (k === 'widthFt' ? 'width' : 'height') + ' must be a positive number of feet or empty.');
      }
      if (isObj(pl.rect) && !tapErrOk(pl.rect.tapErr, 4)) err(who + ': the tap precision of the rectangle must be 4 numbers of 0 or more.');
      if (!Array.isArray(pl.refs)) err(who + ': the references list is missing.');
      arr(pl.refs).forEach((r, j) => {
        const rw = who + ', reference ' + (isObj(r) && typeof r.id === 'string' ? '"' + r.id + '"' : '#' + (j + 1));
        if (!isObj(r)) { err(rw + ' is not an object.'); return; }
        if (!cleanId(r.id) || typeof r.id !== 'string') err(rw + ' has no id.');
        else if (refSeen.has(r.id)) err('Two references share the id "' + r.id + '".');
        else refSeen.add(r.id);
        if (!ENUMS.refKind.includes(r.kind)) { err(rw + ': the kind must be line or rect.'); return; }
        const need = r.kind === 'rect' ? 4 : 2;
        if (!Array.isArray(r.points) || r.points.length !== need || !r.points.every(isPoint)) err(rw + ' needs exactly ' + need + ' points.');
        const sizeKeys = r.kind === 'rect' ? ['widthFt', 'heightFt'] : ['lengthFt'];
        for (const k of sizeKeys) if (r[k] != null && !(typeof r[k] === 'number' && r[k] > 0)) err(rw + ': the size must be a positive number of feet or empty.');
        if (r.kind === 'line' && r.courses != null && !(Number.isInteger(r.courses) && r.courses >= 1)) err(rw + ': the course count must be a whole number of 1 or more.');
        if (!ENUMS.quality.includes(r.quality)) err(rw + ': the quality must be high, medium or low.');
        if (!tapErrOk(r.tapErr, need)) err(rw + ': the tap precision must be ' + need + ' numbers of 0 or more.');
      });
      if (pl.derived !== null) {
        const d = pl.derived;
        if (!isObj(d)) err(who + ': the roof/ground details must be an object or null.');
        else {
          if (!refOk(d.parentPlaneId, planeIds) || d.parentPlaneId === pl.id) err(who + ' is built from a wall that does not exist.');
          if (d.line !== null && !(Array.isArray(d.line) && d.line.length === 2 && d.line.every(isPoint))) err(who + ': the eave or base line needs exactly 2 points.');
          if (d.pitch !== null && !validPitch(d.pitch)) err(who + ': the pitch must be a rise and run (for example 6/12) or empty.');
          if (!tapErrOk(d.tapErr, 2)) err(who + ': the tap precision of the eave or base line must be 2 numbers of 0 or more.');
        }
      }
    });
    dupCheck(lists.planes, 'planes');

    arr(lists.outlets).forEach((o, i) => {
      const who = name('Outlet', o, i);
      if (!isObj(o)) { err(who + ' is not an object.'); return; }
      if (!cleanId(o.id) || typeof o.id !== 'string') err(who + ' has no id.');
      if (!refOk(o.imageId, imageIds)) err(who + ' is on a photo that does not exist.');
      if (!refOk(o.planeId, planeIds)) err(who + ' is on a plane that does not exist.');
      if (o.point !== null && !isPoint(o.point)) err(who + ': the position must be an [x, y] point.');
      if (typeof o.label !== 'string') err(who + ': the label must be text.');
      if (!ENUMS.outletType.includes(o.type)) err(who + ': the type must be one of ' + ENUMS.outletType.join(', ') + '.');
      if (typeof o.gfci !== 'boolean') err(who + ': GFCI must be true or false.');
      if (!refOk(o.circuitId, circuitIds)) err(who + ' is on a circuit that does not exist.');
      if (!(Number.isInteger(o.receptacles) && o.receptacles >= 1)) err(who + ': the socket count must be a whole number of 1 or more.');
    });
    dupCheck(lists.outlets, 'outlets');

    arr(lists.features).forEach((f, i) => {
      const who = name('Feature', f, i);
      if (!isObj(f)) { err(who + ' is not an object.'); return; }
      if (!cleanId(f.id) || typeof f.id !== 'string') err(who + ' has no id.');
      if (!catalog.FEATURE_TYPES[f.type]) err(who + ' has an unknown type ' + JSON.stringify(f.type) + '.');
      if (!refOk(f.imageId, imageIds)) err(who + ' is on a photo that does not exist.');
      if (!refOk(f.planeId, planeIds)) err(who + ' is on a plane that does not exist.');
      if (typeof f.label !== 'string') err(who + ': the label must be text.');
      if (!Array.isArray(f.points) || !f.points.every(isPoint)) err(who + ': the points must be a list of [x, y] points.');
      if (typeof f.closed !== 'boolean') err(who + ': "closed" must be true or false.');
      if (!tapErrOk(f.tapErr, Array.isArray(f.points) ? f.points.length : 0)) err(who + ': the tap precision must be one number of 0 or more for each point.');
      if (f.overrideFt !== null && !(typeof f.overrideFt === 'number' && f.overrideFt > 0)) err(who + ': the tape-measured length must be a positive number of feet or empty.');
      if (f.productId !== null && typeof f.productId !== 'string') err(who + ': the product must be a product id or empty.');
      if (f.color !== null && !(isObj(f.color) && ENUMS.colorMode.includes(f.color.mode) && (f.color.colors === undefined || (Array.isArray(f.color.colors) && f.color.colors.every(isHex))))) {
        err(who + ': the color must be empty or a color mode (with hex colors for custom).');
      }
      const pr = f.params;
      if (!isObj(pr)) { err(who + ': the options (params) are missing.'); return; }
      if (pr.mount !== null && !ENUMS.mount.includes(pr.mount)) err(who + ': the mount must be one of ' + ENUMS.mount.join(', ') + ' or empty.');
      for (const k of ['diameterIn', 'spiralSpacingIn', 'overrideWidthFt', 'overrideHeightFt']) {
        if (pr[k] !== null && !(typeof pr[k] === 'number' && pr[k] > 0)) err(who + ': "' + k + '" must be a positive number or empty.');
      }
      if (pr.wrapMode !== null && !ENUMS.wrapMode.includes(pr.wrapMode)) err(who + ': the wrap mode must be trunk, canopy or empty.');
      if (!refOk(pr.outletId, outletIds)) err(who + ' is assigned to an outlet that does not exist.');
      if (typeof pr.reverse !== 'boolean') err(who + ': "reverse" must be true or false.');
      if (pr.ownCord !== undefined && typeof pr.ownCord !== 'boolean') err(who + ': "ownCord" must be true or false.');
    });
    dupCheck(lists.features, 'features');

    const lib = p.library;
    if (!isObj(lib)) err('The product library settings are missing.');
    else {
      if (lib.products !== null && !(Array.isArray(lib.products) && lib.products.length && lib.products.every((x) => isObj(x) && typeof x.id === 'string' && x.id))) {
        err('The custom product list must be a non-empty list of products that each have an id, or empty.');
      }
      // The same checks as the product editor, so a file can never carry a product the planner would read as 0 W or $0.
      const productIds = new Set();
      arr(lib.products).forEach((x, i) => {
        if (!isObj(x)) return;
        const who = 'Product ' + (typeof x.name === 'string' && x.name ? '"' + x.name + '"' : typeof x.id === 'string' && x.id ? '"' + x.id + '"' : '#' + (i + 1));
        if (typeof x.id === 'string' && x.id) {
          if (productIds.has(x.id)) err('Two products share the id "' + x.id + '".');
          productIds.add(x.id);
        }
        if (!ENUMS.productCategory.includes(x.category)) err(who + ': "category" must be one of ' + ENUMS.productCategory.join(', ') + '.');
        if (!ENUMS.productUnit.includes(x.unit)) err(who + ': "unit" must be one of ' + ENUMS.productUnit.join(', ') + '.');
        for (const k of ['price', 'wattsPerUnit']) if (!(typeof x[k] === 'number' && Number.isFinite(x[k]) && x[k] >= 0)) err(who + ': "' + k + '" must be a number of 0 or more.');
        for (const k of ['stringLengthFt', 'maxEndToEnd']) if (!(typeof x[k] === 'number' && Number.isFinite(x[k]) && x[k] > 0)) err(who + ': "' + k + '" must be a number above 0.');
        // Supplier fields (SPEC §8.3) are free-form except links and the price status.
        if (x.url != null && suppliers.safeUrl(x.url) === null) err(who + ': the link must be an https address.');
        if (x.priceStatus !== undefined && !ENUMS.priceStatus.includes(x.priceStatus)) err(who + ': "priceStatus" must be one of ' + ENUMS.priceStatus.join(', ') + '.');
        if (x.kind !== undefined && x.kind !== null && !ENUMS.productKind.includes(x.kind)) err(who + ': "kind" must be "bulk" or left out.');
        for (const c of suppliers.componentOffers(x)) {
          if (c.offer.url != null && suppliers.safeUrl(c.offer.url) === null) err(who + ': the link of one of its parts must be an https address.');
          if (c.offer.priceStatus !== undefined && !ENUMS.priceStatus.includes(c.offer.priceStatus)) err(who + ': the "priceStatus" of one of its parts must be one of ' + ENUMS.priceStatus.join(', ') + '.');
        }
      });
      if (lib.config !== null && !isObj(lib.config)) err('The library config overrides must be an object or empty.');
      if (isObj(lib.config) && lib.config.buying !== undefined) {
        const b = lib.config.buying;
        if (!isObj(b)) err('The buying settings must be an object.');
        else {
          if (b.style !== undefined && !ENUMS.buyingStyle.includes(b.style)) err('The buying style must be one of ' + ENUMS.buyingStyle.join(', ') + '.');
          if (b.costBasis !== undefined && !ENUMS.costBasis.includes(b.costBasis)) err('The cost basis must be one of ' + ENUMS.costBasis.join(', ') + '.');
        }
      }
      if (lib.supplierId !== undefined && lib.supplierId !== null && !(typeof lib.supplierId === 'string' && lib.supplierId)) err('The supplier must be a supplier id or empty.');
    }
    if (!isObj(p.pricing) || !isObj(p.pricing.overrides)) err('Price overrides are missing.');
    else for (const sku of Object.keys(p.pricing.overrides)) {
      const v = p.pricing.overrides[sku];
      if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) err('The price override for "' + sku + '" must be zero or more.');
    }

    const q = p.quote;
    if (!isObj(q)) err('Quote settings are missing.');
    else {
      if (typeof q.enabled !== 'boolean') err('Quote "enabled" must be true or false.');
      if (typeof q.company !== 'string') err('The company name must be text.');
      if (!ENUMS.laborMethod.includes(q.laborMethod)) err('The labor method must be perFt or perHour.');
      for (const k of ['ratePerFt', 'ratePerHour', 'markupPct', 'takedownFee', 'storageFee']) {
        if (!(typeof q[k] === 'number' && Number.isFinite(q[k]) && q[k] >= 0)) err('Quote "' + k + '" must be zero or more.');
      }
      if (!(typeof q.taxPct === 'number' && q.taxPct >= 0 && q.taxPct <= 100)) err('Tax must be a percentage from 0 to 100.');
      if (!(Number.isInteger(q.validDays) && q.validDays >= 0)) err('Quote validity must be a whole number of days.');
      if (typeof q.notes !== 'string') err('Quote notes must be text.');
    }
  }
  /** tapErr is optional; when present it must be `count` finite numbers of 0 or more. */
  function tapErrOk(v, count) {
    if (v === undefined) return true;
    return Array.isArray(v) && v.length === count && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  }
  function validPitch(v) {
    return isObj(v) && typeof v.rise === 'number' && Number.isFinite(v.rise) && v.rise >= 0 &&
      typeof v.run === 'number' && Number.isFinite(v.run) && v.run > 0;
  }

  // ================================================================ export / import
  /**
   * JSON export wrapper. Pure: the caller passes the export time. imagesByKey maps storageKey → data URL;
   * only photos the project uses are included. derived (normally plan.computePlan output) is JSON-cloned.
   */
  function exportProject(project, derived, imagesByKey, exportedAt) {
    const proj = normalizeProject(project);
    const images = {};
    if (isObj(imagesByKey)) {
      for (const im of proj.images) {
        const key = im.storageKey;
        if (key && typeof imagesByKey[key] === 'string' && /^data:/i.test(imagesByKey[key])) images[key] = imagesByKey[key];
      }
    }
    const d = derived == null ? null : jsonClone(derived);
    return {
      schema: EXPORT_SCHEMA_ID,
      version: EXPORT_VERSION,
      exportedAt: isoOrNull(exportedAt),
      project: proj,
      images,
      derived: isObj(d) ? d : null,
    };
  }

  function looksLikeProject(o) {
    if (!isObj(o)) return false;
    if (o.schema === SCHEMA_ID) return true;
    return o.schema === undefined && (Array.isArray(o.planes) || Array.isArray(o.features) || Array.isArray(o.images));
  }

  /**
   * Read an export wrapper, a bare project, or the JSON text of either. Migrates, normalizes and
   * validates. Throws an Error with a plain message when the data cannot be used.
   */
  function importProject(obj) {
    let data = obj;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { throw new Error(NOT_A_PROJECT); }
    }
    if (!isObj(data)) throw new Error(NOT_A_PROJECT);
    let rawProject = data;
    let rawImages = {};
    if (data.schema === EXPORT_SCHEMA_ID || (data.schema === undefined && isObj(data.project))) {
      // Read the wrapper version the way migrateProject reads a project version: numeric strings count.
      let v = data.version === undefined || data.version === null ? EXPORT_VERSION : data.version;
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
      if (!Number.isInteger(v) || v < 1) {
        throw new Error('This file has an unknown export version (' + String(data.version) + '), so it cannot be opened.');
      }
      if (v > EXPORT_VERSION) {
        throw new Error('This file was exported by a newer version of LightPlan (export version ' + v + '). Update LightPlan to open it.');
      }
      rawProject = data.project;
      rawImages = isObj(data.images) ? data.images : {};
    }
    if (!looksLikeProject(rawProject)) throw new Error(NOT_A_PROJECT);
    const project = normalizeProject(migrateProject(rawProject));
    const check = validateProject(project);
    if (!check.ok) {
      const more = check.errors.length > 3 ? ' (and ' + (check.errors.length - 3) + ' more problems)' : '';
      throw new Error('This project file has problems: ' + check.errors.slice(0, 3).join(' ') + more);
    }
    const images = {};
    for (const im of project.images) {
      const v = im.storageKey ? rawImages[im.storageKey] : undefined;
      if (typeof v === 'string' && /^data:image\//i.test(v)) images[im.storageKey] = v;
    }
    return { project, images };
  }

  return {
    SCHEMA_ID, SCHEMA_VERSION, EXPORT_SCHEMA_ID, EXPORT_VERSION, JSON_SCHEMA, ENUMS, ID_PREFIX,
    uid, createProject, createImage, createPlane, createRef, createFeature, createOutlet, createCircuit,
    createDefaultSettings, createDefaultQuote, quoteFieldProblem,
    normalizeProject, migrateProject, validateProject, exportProject, importProject,
  };
});

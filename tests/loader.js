// Loads LightPlan core modules into Node for unit tests. Missing files are skipped so modules can be
// developed in parallel. Usage: const LP = require('./loader'); const measure = LP.require('measure');
const fs = require('fs');
const path = require('path');
require('../src/core/lp.js');
const CORE = ['geometry', 'camera', 'exif', 'suppliers', 'catalog', 'measure', 'design', 'power', 'bom', 'schema', 'plan', 'sample'];
for (const name of CORE) {
  const file = path.join(__dirname, '..', 'src', 'core', name + '.js');
  if (fs.existsSync(file)) require(file);
}
module.exports = globalThis.LP;

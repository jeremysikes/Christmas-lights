/* LightPlan module registry.
 * Every source file calls LP.define(name, deps, factory). LP.require(name) builds lazily and caches.
 * Works in browsers (global) and Node (globalThis) so core modules can be unit-tested unchanged. */
(function (root) {
  'use strict';
  if (root.LP && root.LP.define) return;
  var registry = Object.create(null);
  var cache = Object.create(null);
  var building = Object.create(null);
  function define(name, deps, factory) {
    if (typeof name !== 'string' || !Array.isArray(deps) || typeof factory !== 'function') {
      throw new Error('LP.define(name, deps, factory) called with bad arguments for ' + name);
    }
    registry[name] = { deps: deps, factory: factory };
    delete cache[name];
  }
  function require(name) {
    if (name in cache) return cache[name];
    var mod = registry[name];
    if (!mod) throw new Error('LightPlan module not found: ' + name);
    if (building[name]) throw new Error('Circular LightPlan module dependency at: ' + name);
    building[name] = true;
    try {
      var args = mod.deps.map(require);
      cache[name] = mod.factory.apply(null, args);
    } finally {
      delete building[name];
    }
    return cache[name];
  }
  function has(name) { return !!registry[name]; }
  root.LP = { define: define, require: require, has: has, names: function () { return Object.keys(registry); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';
// A package directory's package.json: its name, version and license. Shared by the modules that map files to packages
// (packages.cjs, vendored.cjs) and the ones that check a recorded package is still where it was (outputs.cjs).
const fs = require('fs');
const path = require('path');

// "license": "MIT", the legacy {"type": "MIT"} or "licenses": [{"type": "MIT"}, "ISC"]
function licenseOf(j) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : undefined);
  if (j.license !== undefined) return one(j.license);
  if (!Array.isArray(j.licenses)) return undefined;
  const all = j.licenses.map(one).filter(Boolean);
  return all.length ? all : undefined;
}

// The content of dir/package.json, or null. A leading byte order mark is valid UTF-8 that JSON.parse rejects; npm
// strips it too.
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// { name, version, path: dir, license } of package.json content j, or null without name and version
function packageOf(j, dir) {
  if (!j || typeof j.name !== 'string' || !j.name || typeof j.version !== 'string' || !j.version) return null;
  return { name: j.name, version: j.version, path: dir, license: licenseOf(j) };
}

const readPackage = (dir) => packageOf(readManifest(dir), dir);

module.exports = { readPackage, readManifest, packageOf };

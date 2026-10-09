'use strict';
// A package directory's package.json: its name, version and license. Shared by the modules that map files to packages
// (packages.cjs) and the ones that check a recorded package is still where it was (outputs.cjs).
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

// { name, version, path: dir, license } of the package in dir, or null without a package.json with name and version
function readPackage(dir) {
  let j;
  // a leading byte order mark is valid UTF-8 that JSON.parse rejects; npm strips it too
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  if (!j || typeof j.name !== 'string' || !j.name || typeof j.version !== 'string' || !j.version) return null;
  return { name: j.name, version: j.version, path: dir, license: licenseOf(j) };
}

module.exports = { readPackage };

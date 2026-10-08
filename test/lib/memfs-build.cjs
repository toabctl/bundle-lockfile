'use strict';
// Builds the fixture's webpack.config.js (cwd = fixture) into an in-memory output file system, as webpack-dev-middleware
// does (memfs): the lockfile must be an asset there. Fails if anything was written to the real output directory, then
// copies the in-memory output to the real disk, where run.cjs checks it.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const { Volume, createFsFromVolume } = req('memfs');
const vol = new Volume();
const mem = createFsFromVolume(vol);
mem.join = path.join.bind(path); // webpack 4's output file system interface
mem.mkdirp = (dir, cb) => mem.mkdir(dir, { recursive: true }, (err) => cb(err && err.code !== 'EEXIST' ? err : null));
const compiler = webpack(req('./webpack.config.js'));
compiler.outputFileSystem = mem;
fs.rmSync(compiler.outputPath, { recursive: true, force: true });
compiler.run((err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  if (fs.existsSync(compiler.outputPath)) { console.error(`memfs-build: ${compiler.outputPath} was written on the real disk`); process.exit(1); }
  for (const [file, content] of Object.entries(vol.toJSON())) {
    if (content === null) continue; // a directory
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, mem.readFileSync(file));
  }
});

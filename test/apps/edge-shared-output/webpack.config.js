// Two compilers, built in parallel, write to the same output dir (like an app and its service worker):
// they share dist/bundle-lockfile/package-lock.json, which must list the packages of both.
const path = require('path');
const out = { path: path.join(__dirname, 'dist') };
module.exports = [
  { name: 'app', mode: 'production', entry: './src/app.js', output: { ...out, filename: 'app.js' } },
  { name: 'sw', mode: 'production', target: 'webworker', entry: './src/sw.js', output: { ...out, filename: 'sw.js' } },
];

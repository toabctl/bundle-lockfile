'use strict';
// `ng serve` writes no lockfile (cwd = an Angular fixture, NODE_OPTIONS inherited): starts it on a free port, requests
// the page until it is served (the dev server built the app), stops it; fails if the dev server serves bundle-lockfile's
// lockfile, if anything was written to dist/, or if BUNDLE_LOCKFILE_EXPORT_DIR got a file.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { LOCKFILE } = require('./check.cjs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const files = (dir) => { const out = []; const walk = (d) => { let l; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of l) (e.isDirectory() ? walk : (p) => out.push(p))(path.join(d, e.name)); }; walk(dir); return out; };

(async () => {
  fs.rmSync('dist', { recursive: true, force: true });
  if (process.env.BUNDLE_LOCKFILE_EXPORT_DIR) fs.rmSync(process.env.BUNDLE_LOCKFILE_EXPORT_DIR, { recursive: true, force: true });
  const port = await freePort();
  const ng = createRequire(path.resolve('package.json')).resolve('@angular/cli/bin/ng.js');
  const child = spawn(process.execPath, [ng, 'serve', '--port', String(port), '--host', '127.0.0.1'],
    { env: { ...process.env, NG_CLI_ANALYTICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const fail = (msg) => { child.kill(); console.error(msg, `\n${log.slice(-3000)}`); process.exit(1); };
  const get = async (p) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.text() }; } catch { return null; } };
  const end = Date.now() + 3 * 60 * 1000;
  let page = null;
  while (Date.now() < end && !(page && page.status === 200 && page.body.includes('<app-root'))) { await sleep(500); page = await get('/'); }
  if (!page || page.status !== 200) fail('angular-serve: the dev server did not serve the page');
  const lock = await get(`/${LOCKFILE}`);
  if (lock && lock.status === 200 && /"lockfileVersion"/.test(lock.body)) fail(`angular-serve: the dev server serves /${LOCKFILE}`);
  child.kill();
  await new Promise(r => child.on('exit', r));
  if (fs.existsSync('dist')) fail(`angular-serve: dist/ was written: ${files('dist').join(' ')}`);
  const exp = process.env.BUNDLE_LOCKFILE_EXPORT_DIR;
  if (exp && files(exp).length) fail(`angular-serve: the export directory got ${files(exp).join(' ')}`);
  console.log('ng serve: the page served, no lockfile');
})();

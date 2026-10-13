'use strict';
// Vite's dev server and preview server write no lockfile (cwd = a Vite fixture).
// usage: node vite-servers.cjs dev | preview
//   dev      starts `vite`, requests the page and its modules until Vite has pre-bundled the dependencies (its cache
//            directory, VITE_CACHE_DIR or node_modules/.vite, has deps/_metadata.json), stops it; fails if a lockfile
//            of bundle-lockfile is below the cache directory, or anything was written to dist/
//   preview  `vite preview` of the build in dist/ (run before): the page is served; fails if dist/'s lockfile changed
//            or another one was written
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { LOCKFILE } = require('./check.cjs');

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'preview') { console.error('usage: node vite-servers.cjs dev | preview'); process.exit(2); }
const dist = path.resolve('dist');
const cache = path.resolve(process.env.VITE_CACHE_DIR || 'node_modules/.vite');
const TIMEOUT = 3 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().on('error', reject).listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
// every file below dir named like bundle-lockfile's lockfile (bundle-lockfile/package-lock.json)
const lockfiles = (dir) => {
  const out = [];
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(path.join(...LOCKFILE.split('/')))) out.push(p);
    }
  };
  walk(dir);
  return out;
};

(async () => {
  const before = mode === 'preview' ? fs.readFileSync(path.join(dist, LOCKFILE), 'utf8') : null;
  if (mode === 'dev') { fs.rmSync(cache, { recursive: true, force: true }); fs.rmSync(dist, { recursive: true, force: true }); }
  const port = await freePort();
  const server = spawn(path.resolve('node_modules/.bin/vite'), [...(mode === 'preview' ? ['preview'] : []), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; });
  let gone = false;
  const exited = new Promise(r => server.on('exit', r)).then(() => { gone = true; });
  const stop = async () => {
    if (gone) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
    if (await Promise.race([exited.then(() => true), sleep(10000)])) return;
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    await exited;
  };
  const fail = async (msg) => { await stop(); console.error(`vite-servers ${mode}: ${msg}\n${output.split('\n').slice(-30).join('\n')}`); process.exit(1); };
  const get = async (p) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return r.ok ? await r.text() : null; } catch { return null; } };

  const until = Date.now() + TIMEOUT;
  for (;;) {
    if (gone) return fail('the server exited');
    if (Date.now() > until) return fail(`not done within ${TIMEOUT / 60000} minutes`);
    const page = await get('/');
    if (page !== null) {
      if (mode === 'preview') break;
      // the app's entry module and what it imports: the optimizer bundles the dependencies it found
      const main = (page.match(/src="([^"]+\.js)"/) || [])[1];
      if (main) await get(main);
      if (fs.existsSync(path.join(cache, 'deps', '_metadata.json'))) break;
    }
    await sleep(500);
  }
  await stop();
  if (mode === 'dev') {
    const found = lockfiles(cache);
    if (found.length) return fail(`lockfiles below Vite's cache directory: ${found.join(' ')}`);
    if (fs.existsSync(dist)) return fail(`${dist} was written`);
    console.log(`no lockfile below ${path.relative(process.cwd(), cache)} (dependencies pre-bundled), nothing in dist/`);
  } else {
    if (fs.readFileSync(path.join(dist, LOCKFILE), 'utf8') !== before) return fail(`${LOCKFILE} in dist/ changed`);
    const found = lockfiles(dist).filter(f => f !== path.join(dist, LOCKFILE));
    if (found.length) return fail(`other lockfiles: ${found.join(' ')}`);
    console.log('preview served dist/, its lockfile unchanged');
  }
})().catch((e) => { console.error(e); process.exit(1); });

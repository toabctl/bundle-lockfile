'use strict';
// Starts a dev server (cwd = fixture; `rspack serve`, `rsbuild dev`, given with --host 127.0.0.1 --port <a free port>
// added: on the loopback interface only, not every interface of the machine it runs on), fetches the
// lockfile it serves from memory, /bundle-lockfile/package-lock.json, and stops it. Fails if the server does not serve
// it within 3 minutes, or if anything was written to the output directory (dist/) on the real disk; then writes the
// fetched lockfile to dist/, where run.cjs checks it (as memfs-build.cjs does).
// --on-disk: the server writes its output to disk (writeToDisk): waits for the lockfile in dist/ instead, and leaves it
// usage: node dev-server.cjs [--on-disk] <command> [args...]
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { LOCKFILE } = require('./check.cjs');

const onDisk = process.argv[2] === '--on-disk';
const [cmd, ...args] = process.argv.slice(onDisk ? 3 : 2);
if (!cmd) { console.error('usage: node dev-server.cjs [--on-disk] <command> [args...]'); process.exit(2); }
const dist = path.resolve('dist');
const TIMEOUT = 3 * 60 * 1000;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().on('error', reject).listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const port = await freePort();
  // its own process group, so that the server's own child processes stop with it
  const server = spawn(cmd, [...args, '--host', '127.0.0.1', '--port', String(port)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; });
  const exited = new Promise(r => server.on('exit', r));
  let gone = false;
  exited.then(() => { gone = true; });
  const stop = async () => {
    if (gone) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
    if (await Promise.race([exited.then(() => true), sleep(10000)])) return;
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    await exited;
  };
  const fail = async (msg) => {
    await stop();
    console.error(`dev-server: ${msg}\n${output.split('\n').slice(-30).join('\n')}`);
    process.exit(1);
  };

  // the dev middleware answers once the first build is done; until the server listens, the request fails. Other paths
  // may be answered with the app's page (Rsbuild's history fallback): only a lockfile counts
  const url = `http://127.0.0.1:${port}/${LOCKFILE}`;
  const until = Date.now() + TIMEOUT;
  let text = null;
  while (text === null) {
    const what = onDisk ? `wrote ${path.join(dist, LOCKFILE)}` : `served ${url}`;
    if (gone) return fail(`${cmd} exited before it ${what}`);
    if (Date.now() > until) return fail(`${cmd} has not ${what} within ${TIMEOUT / 60000} minutes`);
    try {
      const body = onDisk ? fs.readFileSync(path.join(dist, LOCKFILE), 'utf8') : await (async () => {
        const res = await fetch(url);
        return res.ok ? res.text() : '';
      })();
      if (JSON.parse(body).lockfileVersion) text = body;
    } catch { /* not listening yet, not written yet, or not the lockfile */ }
    if (text === null) await sleep(500);
  }
  await stop();
  const written = path.join(dist, LOCKFILE);
  if (onDisk) return undefined;
  if (fs.existsSync(dist)) return fail(`${dist} was written on the real disk: ${fs.readdirSync(dist, { recursive: true }).join(' ')}`);
  fs.mkdirSync(path.dirname(written), { recursive: true });
  fs.writeFileSync(written, text);
})().catch((e) => { console.error(e); process.exit(1); });

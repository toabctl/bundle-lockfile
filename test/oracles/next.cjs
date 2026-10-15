'use strict';
// Oracle for Next.js fixtures: runs `next build <args>` WITHOUT bundle-lockfile, into a separate distDir,
// with next-stats-plugin.cjs added to every webpack compiler via the fixture's next.config.js.
// usage (cwd = fixture): node oracles/next.cjs [next build args, e.g. --webpack]
// prints {"<compiler output dir relative to distDir>": [name@version, ...], ...}, and "runtime": the packages of the
// files Next.js traced for its server (the .nft.json files of the oracle's build, mapped by owner.cjs) - what the
// server loads from node_modules at runtime.
// BLTEST_ORACLE_STANDALONE=1 (output: 'standalone', the case's output .next/standalone): the outputs as they are below
// .next/standalone instead - "" the runtime packages (its node_modules), and each compiler output whose directory Next
// copied there, at its path there (the oracle's distDir named .next, as the case's)
// BLTEST_ORACLE_EXPORT=1 (a static export, the case's output out/): the client's output as it is there, at _next/ (Next
// copies .next/static to out/_next/static)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const owner = require('./owner.cjs');

const out = path.resolve('.oracle-stats');
fs.rmSync(out, { recursive: true, force: true });
const r = spawnSync(path.resolve('node_modules/.bin/next'), ['build', ...process.argv.slice(2)], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    BLTEST_ORACLE_PLUGIN: path.join(__dirname, 'next-stats-plugin.cjs'),
    BLTEST_ORACLE_OUT: out,
  },
});
if (r.status !== 0) { console.error(`oracle: next build exited ${r.status}`); process.exit(1); }

const result = {};
for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) {
  const { output, packages } = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  result[output] = [...new Set([...(result[output] || []), ...packages])].sort(); // compilers sharing an output dir
}
// the oracle's distDir: .next-oracle (the fixtures' next.config.js, for oracle builds), or .next (output: 'export')
const distDir = path.resolve(fs.existsSync('.next-oracle') ? '.next-oracle' : '.next');
const traceFiles = [];
const walk = (d, top) => {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!top || !['cache', 'standalone', 'static', 'diagnostics', 'node_modules'].includes(e.name)) walk(p, false); }
    else if (e.name.endsWith('.nft.json')) traceFiles.push(p);
  }
};
walk(distDir, true);
if (traceFiles.length) {
  const files = traceFiles.flatMap(t => JSON.parse(fs.readFileSync(t, 'utf8')).files.map(f => path.resolve(path.dirname(t), f)));
  result.runtime = owner.packagesOf(files, { context: fs.realpathSync('.') }).sort();
}
if (process.env.BLTEST_ORACLE_STANDALONE) {
  // the project is the tracing root in these fixtures: .next/standalone mirrors it
  const standalone = path.join(distDir, 'standalone'), there = {};
  if (result.runtime) there[''] = result.runtime;
  for (const [k, list] of Object.entries(result)) {
    if (k === 'runtime') continue;
    if (fs.existsSync(path.join(standalone, path.basename(distDir), k))) there[path.posix.join('.next', k).replace(/\/$/, '')] = list;
  }
  console.log(JSON.stringify(there));
} else if (process.env.BLTEST_ORACLE_EXPORT) console.log(JSON.stringify(result[''] ? { _next: result[''] } : {}));
else console.log(JSON.stringify(result));

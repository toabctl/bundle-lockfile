'use strict';
// Oracle for Next.js fixtures: runs `next build <args>` WITHOUT bundle-lockfile, into a separate distDir,
// with next-stats-plugin.cjs added to every webpack compiler via the fixture's next.config.js.
// usage (cwd = fixture): node oracles/next.cjs [next build args, e.g. --webpack]
// prints {"<compiler output dir relative to distDir>": [name@version, ...], ...}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const out = path.resolve('.oracle-stats');
fs.rmSync(out, { recursive: true, force: true });
const r = spawnSync(path.resolve('node_modules/.bin/next'), ['build', ...process.argv.slice(2)], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    BUNDLE_LOCKFILE_ORACLE_PLUGIN: path.join(__dirname, 'next-stats-plugin.cjs'),
    BUNDLE_LOCKFILE_ORACLE_OUT: out,
  },
});
if (r.status !== 0) { console.error(`oracle: next build exited ${r.status}`); process.exit(1); }

const result = {};
for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) {
  const { output, packages } = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  result[output] = [...new Set([...(result[output] || []), ...packages])].sort(); // compilers sharing an output dir
}
console.log(JSON.stringify(result));

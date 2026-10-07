'use strict';
// Splits the matrix into shards that run as separate CI jobs: "--shard=<i>/<n>" selects the fixtures of shard
// i (1-based) of n, and gen.cjs and run.cjs agree on them. A fixture and all its cases stay in one shard (cases
// of a fixture share its directory and must not run concurrently). Fixtures are spread by estimated cost
// (longest first, each to the least loaded shard), from CI timings: a fixture install or a case ~5 s, a
// Next.js case ~20 s.
const { fixtures, cases } = require('../matrix.cjs');

// "--shard=2/5" anywhere in argv -> { i: 2, n: 5 }; the other arguments in order. Without one: shard 1/1.
function parseArgs(argv) {
  const rest = [];
  let shard = { i: 1, n: 1 };
  for (const a of argv) {
    const m = a.match(/^--shard=(\d+)\/(\d+)$/);
    if (!m) { rest.push(a); continue; }
    shard = { i: Number(m[1]), n: Number(m[2]) };
    if (!(shard.n >= 1 && shard.i >= 1 && shard.i <= shard.n)) throw new Error(`invalid ${a}`);
  }
  return { shard, rest };
}

function cost(name) {
  const caseCost = fixtures[name].bundler === 'next' ? 4 : 1;
  return 1 + caseCost * cases.filter(c => c.fixture === name).length;
}

// fixture names of shard i of n
function fixturesOf({ i, n }) {
  const load = new Array(n).fill(0), assigned = new Array(n).fill(null).map(() => []);
  const names = Object.keys(fixtures).sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const s = load.indexOf(Math.min(...load));
    load[s] += cost(name);
    assigned[s].push(name);
  }
  return new Set(assigned[i - 1]);
}

module.exports = { parseArgs, fixturesOf };

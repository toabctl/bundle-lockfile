'use strict';
// Preload that reports wall time and peak RSS of every node process it is loaded into (NODE_OPTIONS
// reaches child processes too, e.g. type checkers); the line names the script so they can be told apart.
const start = process.hrtime.bigint();
process.on('exit', () => {
  const s = Number(process.hrtime.bigint() - start) / 1e9;
  const script = require('path').basename(process.argv[1] || 'node');
  console.error(`[measure] pid=${process.pid} script=${script} wall=${s.toFixed(1)}s maxRSS=${Math.round(process.resourceUsage().maxRSS / 1024)}MB`);
});

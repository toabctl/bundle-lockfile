'use strict';
// Test-only preload, put before register.cjs in NODE_OPTIONS: Rolldown's plugin contexts look like those of a Rolldown
// bundle-lockfile does not know (src/adapters/rolldown-watch.cjs cannot wrap them), to prove that a Rolldown build with
// style sheets fails then (strict mode) - and with BUNDLE_LOCKFILE_STRICT=0 is listed without them.
const watch = require('../../src/adapters/rolldown-watch.cjs');
watch.start = watch.wrap = () => 'injected fault (test/lib/rolldown-shape.cjs)';

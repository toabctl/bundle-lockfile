const debug = require('debug');  // only in sw.js: debug@2.6.9 + its ms@2.0.0
self.addEventListener('install', () => debug('sw')('installed'));

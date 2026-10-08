const ms = require('ms');  // only in sw.js (EDGE_COMPRESSION=two)
self.addEventListener('install', () => console.log(ms('1h')));

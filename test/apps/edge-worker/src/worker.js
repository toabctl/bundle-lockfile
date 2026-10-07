import Nested from 'worker-loader!./nested.js';  // a child compiler of the child compiler
const ms = require('ms');                         // only in the worker: ms@2.1.3
self.postMessage([ms('1h'), new Nested()]);

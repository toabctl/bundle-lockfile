const isNumber = require('is-number');  // only in the inlined worker: is-number@7.0.0
self.postMessage(isNumber(1));

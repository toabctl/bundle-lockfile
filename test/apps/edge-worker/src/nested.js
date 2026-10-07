const debug = require('debug');                   // only in the nested worker: debug@2.6.9 + its ms@2.0.0
self.postMessage(debug('x'));

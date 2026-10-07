const debug = require('debug');  // debug@2.6.9 with nested ms@2.0.0
const ms = require('ms');        // ms@2.1.3
console.log(debug('x'), ms('1h'));

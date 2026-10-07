const ms = require('ms');               // ms@2.1.3
const msOld = require('ms-old');        // npm alias: "ms-old": "npm:ms@2.0.0" -> installed as node_modules/ms-old, real name "ms"
// debug@2.6.9 and the alias debug-old (debug@2.6.8) each get their own nested copy of ms@2.0.0:
// the same name@version at two more paths
const debug = require('debug');
const debugOld = require('debug-old');
console.log(ms('1h'), msOld('1h'), debug('a'), debugOld('b'));

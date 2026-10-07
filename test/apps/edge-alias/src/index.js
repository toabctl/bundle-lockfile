const ms = require('ms');         // ms@2.1.3
const msOld = require('ms-old');  // npm alias: "ms-old": "npm:ms@2.0.0" -> installed as node_modules/ms-old, real name "ms"
console.log(ms('1h'), msOld('1h'));

import { chunk } from 'lodash-es';      // ESM, sideEffects:false, used -> scope hoisting
import { v4 } from 'uuid';              // imported but UNUSED -> must not be listed (webpack >= 4 drops it)
import { Yallist } from 'yallist';      // resolves into dist/{esm,commonjs}/ which have their own {"type":...} package.json
const debug = require('debug');         // CJS, depends on nested ms@2.0.0
const ms = require('ms');               // top-level ms@2.1.3
import('nanoid').then(m => console.log(m.nanoid()));  // async chunk
console.log(chunk([1,2,3,4], 2), debug('x'), ms('1h'), new Yallist([1]));

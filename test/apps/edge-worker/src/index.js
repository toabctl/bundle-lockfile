import Worker from 'worker-loader!./worker.js';  // child compiler -> dist/<hash>.worker.js
// inlined: the worker's code is a string in main.js, its file is not emitted
import Inline from 'worker-loader?inline=no-fallback!./inline.js';
import { chunk } from 'lodash-es';
console.log(new Worker(), new Inline(), chunk([1, 2, 3, 4], 2));

import Worker from 'worker-loader!./worker.js';  // child compiler -> dist/<hash>.worker.js
import { chunk } from 'lodash-es';
console.log(new Worker(), chunk([1, 2, 3, 4], 2));

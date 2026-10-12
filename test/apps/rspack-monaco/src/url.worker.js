import isNumber from 'is-number'; // only in this worker (new Worker(new URL(...)) in src/index.js)
self.onmessage = (e) => self.postMessage(isNumber(e.data));

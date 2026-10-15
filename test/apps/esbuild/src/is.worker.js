import isNumber from 'is-number'; // only in the worker (build.mjs worker-inline, worker-file)
self.onmessage = (e) => self.postMessage(isNumber(e.data));

import isNumber from 'is-number';
self.onmessage = (e) => self.postMessage(isNumber(e.data));

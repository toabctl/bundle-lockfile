import { chunk } from 'lodash-es';
navigator.serviceWorker.register('/sw.js');
console.log(chunk([1, 2, 3, 4], 2));

import 'normalize.css';                 // CSS from a package: an extracted asset
import { chunk } from 'lodash-es';      // tree-shaken: only chunk and what it needs
import debug from 'debug';              // debug@2.6.9 and its own ms@2.0.0
console.log(chunk([1, 2, 3, 4], 2));
debug('vite-spa')('started');
import('./lazy.js').then((m) => m.run()); // a lazily loaded chunk with ms@2.1.3

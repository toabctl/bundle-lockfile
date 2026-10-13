import { chunk } from 'lodash-es';  // tree-shaken: only chunk and what it needs
import { v4 } from 'uuid';          // imported but unused (sideEffects: false): not shipped, not listed
import debug from 'debug';          // CommonJS, with its own ms@2.0.0
import ms from 'ms';                // ms@2.1.3
import font from 'bootstrap-icons/font/fonts/bootstrap-icons.woff2'; // the file loader: an asset of the output
import './style.css';               // @imports normalize.css: the CSS output
console.log(chunk([1, 2, 3, 4], 2), debug('x'), ms('1h'), font);
export const lazy = () => import('nanoid').then(m => m.nanoid()); // a lazily loaded chunk; left out by the watch mode's 2nd build

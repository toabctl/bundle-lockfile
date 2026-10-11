import './app.css';     // native CSS: @import of normalize.css
import './styles.scss'; // @use of a Sass partial from bulma, inlined by sass-loader
import './theme.less';  // @import of normalize.less, inlined by less-loader
import font from 'bootstrap-icons/font/fonts/bootstrap-icons.woff2'; // emitted as a file, only its URL is in main.js
import { chunk } from 'lodash-es';
import { A } from 'consts-only';   // only constants: inlined into main.js (rspack 1.7 and later), its module is in no chunk
import B from 'consts-default';     // a default export: inlined by rspack 2 only
const worker = new Worker(new URL('./worker.js', import.meta.url)); // a worker chunk (is-number)
worker.onmessage = (e) => console.log(e.data);
console.log(font, chunk([1, 2, 3, 4], 2), A, B);

import './app.css';                                          // @import 'sanitize.css' inside: a CSS-only package
import './styles.scss';                                      // @use of bulma's Sass partial
import './theme.less';                                       // @import of normalize.less (it inlines normalize.css)
import InlineWorker from './inline-worker.js?worker&inline'; // is-number, inlined into this chunk as a string
import { chunk } from 'lodash-es';
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); // nanoid, a separate worker file
new InlineWorker();
console.log(chunk([1, 2, 3, 4], 2));

import { chunk } from 'lodash-es'; // tree-shaken: only chunk and what it needs
import { nanoid } from 'nanoid';   // its browser build (package.json "browser")
const unused = { size: 2 };
if (false) console.log(unused);    // kept by esbuild (no minify), dropped by Rollup: treeshake changes the bytes tsup writes
console.log(chunk([1, 2, 3, 4], 2), nanoid());

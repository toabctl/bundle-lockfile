import { chunk } from 'lodash-es'; // tree-shaken: only chunk and what it needs
import { nanoid } from 'nanoid';   // its browser build (package.json "browser"); left out by the watch case's 2nd build
console.log(chunk([1, 2, 3, 4], 2));
console.log(nanoid());

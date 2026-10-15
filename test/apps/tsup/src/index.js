import { chunk } from 'lodash-es'; // tree-shaken: only chunk and what it needs
import { nanoid } from 'nanoid';   // its browser build (package.json "browser")
console.log(chunk([1, 2, 3, 4], 2), nanoid());

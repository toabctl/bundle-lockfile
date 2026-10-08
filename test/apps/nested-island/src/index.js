import { chunk } from 'lodash-es';
import '../island/dist/main.js';   // prebuilt by Vite: webpack sees one first-party file
console.log(chunk([1, 2], 1), window.island());

// NESTED_ENTRY=split-js: only the split island's JavaScript - not its style sheet, nor normalize.css in it
import { chunk } from 'lodash-es';
import { island, later } from '../island/dist/main.js';
console.log(chunk([1, 2], 1), island(), later());

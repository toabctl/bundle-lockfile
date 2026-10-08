// NESTED_ENTRY=split: the split island's JavaScript (main.js, which imports lazy.js) and its style sheet
import { chunk } from 'lodash-es';
import { island, later } from '../island/dist/main.js';
import '../island/dist/style.css';
console.log(chunk([1, 2], 1), island(), later());

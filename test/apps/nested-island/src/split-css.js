// NESTED_ENTRY=split-css: only the split island's style sheet - none of its JavaScript's packages
import { chunk } from 'lodash-es';
import '../island/dist/style.css';
console.log(chunk([1, 2], 1));

import { chunk } from 'lodash-es';
import '../copied/island/dist/main.js'; // the island's output copied there with cp (see the matrix case)
console.log(chunk([1, 2], 1), window.island());

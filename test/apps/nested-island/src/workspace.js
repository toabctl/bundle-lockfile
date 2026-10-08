import { chunk } from 'lodash-es';
import '@acme/island';             // the prebuilt island as a workspace package: node_modules/@acme/island -> island
console.log(chunk([1, 2], 1), window.island());

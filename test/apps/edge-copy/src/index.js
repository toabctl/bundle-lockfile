import { chunk } from 'lodash-es';  // bundled; normalize.css is only copied (see webpack.config.js)
console.log(chunk([1, 2, 3, 4], 2));

import { chunk } from 'lodash-es';      // dependency, used
import cn from 'classnames';            // devDependency, but IMPORTED -> shipped in the bundle -> must be listed
// is-number: dependency, never imported -> not shipped -> must not be listed
// left-pad:  devDependency, never imported -> must not be listed
console.log(chunk([1, 2, 3, 4], 2), cn('a', { b: true }));

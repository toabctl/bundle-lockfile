import { chunk } from 'lodash-es'; // a devDependency: bundled
import ms from 'ms';               // a dependency: external, imported at runtime
export const pairs = (xs) => chunk(xs.map(x => ms(x)), 2);

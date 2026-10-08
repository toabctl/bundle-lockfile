import ms from 'ms';                 // only in the remote
import { chunk } from 'lodash-es';   // shared, with the remote's own fallback
export const label = () => `${ms('1h')} ${chunk([1], 1)}`;

import { chunk } from 'lodash-es';      // ESM, used
import { v4 } from 'uuid';              // imported but UNUSED -> must not be listed
import ms from 'ms';

export default function Home() {
  return <p>{ms(3600000)} {chunk([1, 2, 3, 4], 2).length}</p>;
}

import { chunk } from 'lodash-es';   // shared: the host's own copy is its fallback
import('remote/widget').then(w => console.log(chunk([1, 2], 1), w.label())); // from the remote at runtime: not in the host

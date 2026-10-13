// Rollup, Rolldown and Vite: include-loader.cjs as a plugin - the included file is no module, only a watch file of the
// build (this.addWatchFile, in the load hook). moduleType: Rolldown's, for a file of an extension it does not know.
import fs from 'node:fs';
import { createRequire } from 'node:module';

export default function include() {
  return {
    name: 'canary-include',
    load(id) {
      if (!id.endsWith('.glsl')) return null;
      const require = createRequire(id);
      const code = fs.readFileSync(id, 'utf8').replace(/^#include "(.+)"$/gm, (_, request) => {
        const file = require.resolve(request);
        this.addWatchFile(file);
        return fs.readFileSync(file, 'utf8');
      });
      return { code: `export default ${JSON.stringify(code)};`, moduleType: 'js' };
    },
  };
}

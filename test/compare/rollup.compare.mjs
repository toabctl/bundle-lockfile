// Comparison tooling: the fixture's rollup.config.mjs plus rollup-plugin-license, rollup-plugin-sbom and the
// diagnostics (diag-rollup.cjs), in every config. fixtures.sh copies it into the fixture and runs
// `rollup -c .compare.rollup.mjs`; BLTEST_COMPARE_DIR has the tools, BLTEST_COMPARE_REPO is this repository.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import base from './rollup.config.mjs';

const tools = createRequire(path.join(process.env.BLTEST_COMPARE_DIR, 'package.json'));
const load = async (name) => { const m = await import(pathToFileURL(tools.resolve(name)).href); return m.default || m; };
const license = await load('rollup-plugin-license'), sbom = await load('rollup-plugin-sbom');
const diag = createRequire(path.join(process.env.BLTEST_COMPARE_REPO, 'package.json'))('./test/compare/diag-rollup.cjs');
const list = (deps) => JSON.stringify(deps.map(d => ({ name: d.name, version: d.version || '' })), null, 2);

const configs = [].concat(typeof base === 'function' ? await base({}) : base);
export default configs.map((c) => {
  const o = [].concat(c.output)[0];
  const outDir = path.resolve(o.dir || path.dirname(o.file));
  return { ...c, plugins: [...[].concat(c.plugins || []),
    license({ thirdParty: { output: { file: path.join(outDir, 'bundle-lockfile-compare/rpl.json'), template: list } } }),
    sbom({ outDir: 'bundle-lockfile-compare/sbom', includeWellKnown: false, saveTimestamp: false }),
    diag({ outDir })] };
});

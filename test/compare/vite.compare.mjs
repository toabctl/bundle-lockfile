// Comparison tooling: the fixture's own Vite config plus the tools that list a Vite build's packages -
// rollup-plugin-license, rollup-plugin-sbom, Vite's build.license (Vite 8) - and the diagnostics (diag-rollup.cjs).
// fixtures.sh copies it into the fixture and runs `vite build --config .compare.vite.mjs`; BLTEST_COMPARE_DIR has
// the tools, BLTEST_COMPARE_REPO is this repository. Each tool writes below <outDir>/bundle-lockfile-compare/.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfigFromFile, mergeConfig, version } from 'vite';

const tools = createRequire(path.join(process.env.BLTEST_COMPARE_DIR, 'package.json'));
const load = async (name) => { const m = await import(pathToFileURL(tools.resolve(name)).href); return m.default || m; };
const license = await load('rollup-plugin-license'), sbom = await load('rollup-plugin-sbom');
const diag = createRequire(path.join(process.env.BLTEST_COMPARE_REPO, 'package.json'))('./test/compare/diag-rollup.cjs');

const base = (await loadConfigFromFile({ command: 'build', mode: 'production' }, undefined, process.cwd())) || { config: {} };
const root = path.resolve(base.config.root || process.cwd());
const outDir = path.resolve(root, (base.config.build && base.config.build.outDir) || 'dist');
const list = (deps) => JSON.stringify(deps.map(d => ({ name: d.name, version: d.version || '' })), null, 2);
export default mergeConfig(base.config, {
  plugins: [
    license({ thirdParty: { output: { file: path.join(outDir, 'bundle-lockfile-compare/rpl.json'), template: list } } }),
    sbom({ outDir: 'bundle-lockfile-compare/sbom', includeWellKnown: false, saveTimestamp: false }),
    diag({ outDir }),
  ],
  ...(Number(version.split('.')[0]) >= 8 && { build: { license: { fileName: 'bundle-lockfile-compare/vite-license.json' } } }),
});

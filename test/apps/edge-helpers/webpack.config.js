// EDGE_HELPERS: which transpiler compiles src/ for an old target, and whether it inlines its helpers (core/helpers.cjs):
//   babel         babel-loader, preset-env: Babel's helpers inlined (@babel/helpers)
//   babel-runtime the same with plugin-transform-runtime: most helpers imported from @babel/runtime, some still inlined
//   ts            ts-loader to ES5: TypeScript's __awaiter and __generator inlined (typescript)
//   ts-tslib      the same with importHelpers: imported from tslib
//   swc           swc-loader to ES5: swc's helpers inlined (@swc/core)
//   swc-external  the same with externalHelpers: imported from @swc/helpers
const path = require('path');
const mode = process.env.EDGE_HELPERS || 'babel';
const babel = (plugins) => ({ loader: 'babel-loader', options: { babelrc: false, configFile: false, presets: [['@babel/preset-env', { targets: 'ie 11' }]], plugins } });
const swc = (externalHelpers) => ({ loader: 'swc-loader', options: { env: { targets: 'ie 11' }, jsc: { externalHelpers } } });
const ts = (importHelpers) => ({ loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { target: 'es5', lib: ['es2015', 'dom'], importHelpers } } });
const use = { babel: babel([]), 'babel-runtime': babel(['@babel/plugin-transform-runtime']), ts: ts(false), 'ts-tslib': ts(true), swc: swc(false), 'swc-external': swc(true) }[mode];
module.exports = {
  mode: 'production', entry: mode.startsWith('ts') ? './src/index.ts' : './src/index.js',
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, target: ['web', 'es5'],
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [{ test: mode.startsWith('ts') ? /\.ts$/ : /\.js$/, exclude: /node_modules/, use }] },
};

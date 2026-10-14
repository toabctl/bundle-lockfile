// Node.js internals bundle-lockfile hooks (hooks.cjs) or probes (core/vendored.cjs), which @types/node does not declare.
// For the type check only (tsconfig.json).
import 'node:module';

declare module 'node:module' {
  namespace Module {
    /** the loaders of CommonJS modules by file extension */
    var _extensions: { [ext: string]: ((module: Module, filename: string) => unknown) | undefined };
    /** require.cache */
    var _cache: { [filename: string]: Module | undefined };
    /** Yarn Plug'n'Play's API, where its runtime is loaded */
    var findPnpApi: ((lookupSource: string) => any) | undefined;
  }
}

declare global {
  namespace NodeJS {
    interface Module {
      /** runs a CommonJS module's code */
      _compile(content: string, filename: string): unknown;
    }
  }
}

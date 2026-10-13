// webpack and rspack: a shader as a module, its `#include "<package>/<file>"` lines replaced by the file's text - as
// glslify-loader inlines its imports. The included file is no module: only a file dependency of the shader's module.
const fs = require('fs');
module.exports = function (source) {
  const out = source.replace(/^#include "(.+)"$/gm, (_, request) => {
    const file = require.resolve(request, { paths: [this.context] });
    this.addDependency(file);
    return fs.readFileSync(file, 'utf8');
  });
  return `export default ${JSON.stringify(out)};`;
};

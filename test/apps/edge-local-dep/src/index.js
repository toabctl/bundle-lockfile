// local-lib is a directory of the project, a dependency as file:, link: or portal: (see the fixtures): installed as a
// symlink it is first-party, copied into node_modules (yarn 2+ and pnpm with file:) a package
const { label } = require('local-lib');
console.log(label('1h'));

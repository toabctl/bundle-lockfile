// syntax an old target lacks, so the transpiler writes helpers: a class, an async function, object spread, a named
// capture group (Babel's _wrapRegExp, CVE-2025-27789)
export class Greeter {
  constructor(name) { this.opts = { ...{ name }, loud: false }; }
  async greet() { return 'hi a'.replace(/(?<who>a)/, '$<who>') + this.opts.name; }
}
new Greeter('x').greet().then((g) => console.log(g));

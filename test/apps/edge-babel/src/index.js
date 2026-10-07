// no polyfill/helper imports here: babel-loader injects core-js (preset-env useBuiltIns: 'usage')
// and @babel/runtime helpers (plugin-transform-runtime) for the old target below
class Greeter { #name; constructor(n) { this.#name = n; } async greet() { return [this.#name].includes('x') ? 'hi' : 'hello'; } }
new Greeter('x').greet().then(g => console.log(g, Object.fromEntries([['a', 1]]), new Set([1]).size));

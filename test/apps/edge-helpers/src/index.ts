// syntax ES5 lacks, so TypeScript writes helpers (__awaiter, __generator, __extends)
class Base { constructor(public name: string) {} }
export class Greeter extends Base { async greet(): Promise<string> { return `hi ${this.name}`; } }
new Greeter('x').greet().then((g) => console.log(g));

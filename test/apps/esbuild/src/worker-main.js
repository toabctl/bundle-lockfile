import code from './is.worker.js'; // inlined as a string by build.mjs's worker-inline plugin
const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
console.log(new Worker(url));

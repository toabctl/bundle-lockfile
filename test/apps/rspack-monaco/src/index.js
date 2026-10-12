import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { chunk } from 'lodash-es'; // only in main.js
// Monaco's editor worker as a worker of this compilation, as redpanda-console starts it
const editor = new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url));
const own = new Worker(new URL('./url.worker.js', import.meta.url));
monaco.editor.create(document.body, { value: JSON.stringify(chunk([1, 2, 3], 2)), language: 'json' });
console.log(editor, own);

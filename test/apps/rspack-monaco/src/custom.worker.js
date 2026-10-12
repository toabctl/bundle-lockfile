import ms from 'ms'; // only in this worker, which MonacoWebpackPlugin builds in a child compilation (customLanguages)
import 'monaco-editor/esm/vs/editor/editor.worker';
self.onmessage = (e) => self.postMessage(ms(e.data));

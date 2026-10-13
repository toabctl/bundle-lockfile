import { nanoid } from 'nanoid';
// a package's font, only in the worker: Vite emits it from the worker's build, and the app's build emits it again
const font = new URL('../node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2', import.meta.url);
self.postMessage([nanoid(), font.href]);

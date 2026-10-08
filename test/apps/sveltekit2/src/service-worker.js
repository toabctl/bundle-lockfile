import { nanoid } from 'nanoid'; // the service worker: SvelteKit builds it with a nested Vite build
self.addEventListener('install', () => console.log(nanoid()));

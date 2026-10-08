// The service worker vite-plugin-pwa's injectManifest strategy builds (PWA_INJECT=1, see vite.config.mjs)
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

precacheAndRoute(self.__WB_MANIFEST);
registerRoute(({ request }) => request.destination === 'image', new CacheFirst());

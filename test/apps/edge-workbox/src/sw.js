import { precacheAndRoute } from 'workbox-precaching';  // only in the service worker
precacheAndRoute(self.__WB_MANIFEST);

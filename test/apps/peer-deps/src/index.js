// Packages with peer dependencies: Yarn Plug'n'Play gives them virtual paths (.yarn/__virtual__/...), pnpm directories
// named after the peers (.pnpm/react-dom@19.3.0_react@19.3.0/...)
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'use-sync-external-store/shim';
createRoot(document.body).render(createElement('p', null, String(typeof useSyncExternalStore)));

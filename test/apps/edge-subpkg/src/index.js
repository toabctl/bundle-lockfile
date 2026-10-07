// preact ships subpath manifests with their own name/version: preact/hooks/package.json is
// {"name": "preact-hooks", "version": "0.1.0", "private": true}. The package is still preact.
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
function App() { const [n] = useState(1); return h('p', null, n); }
render(h(App), document.body);

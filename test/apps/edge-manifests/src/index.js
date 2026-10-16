// Packages with package.json files inside them that are no packages of their own (see test/unit/core.test.cjs, "vendored:
// package.json files inside real packages"): preact's private hooks/ and compat/ (preact-hooks, preact-compat),
// @duetds/date-picker's dist/loader/ (duet-loader, no version), socket.io-client's and engine.io-client's build/esm/
// (the package's own name; engine.io-client's without a version). Each must be listed as the package that has it.
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { defineCustomElements } from '@duetds/date-picker/dist/loader';
import { io } from 'socket.io-client';

const Counter = forwardRef(() => { const [n] = useState(0); return h('b', null, n); });
render(h(Counter), document.body);
defineCustomElements(window);
console.log(io('/', { autoConnect: false }));

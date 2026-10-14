import { Component } from '@angular/core';
import { chunk } from 'lodash-es'; // tree-shaken: only chunk and what it needs
import { v4 } from 'uuid';         // imported but unused (sideEffects: false): not shipped, not listed
import ms from 'ms';

@Component({ selector: 'app-root', template: '<p>{{ text }}</p>' })
export class App {
  text = JSON.stringify(chunk([1, 2, 3, 4], 2)) + ms('1h');
  // three lazily loaded chunks: Angular's chunk optimizer re-bundles them (with optimized scripts, from three on)
  lazy() { return Promise.all([import('nanoid').then(m => m.nanoid()), import('is-number'), import('debug')]); }
}

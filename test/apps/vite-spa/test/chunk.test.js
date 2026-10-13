// Vitest (the vite8-vitest fixture): it transforms modules with Vite, and builds nothing that ships
import { test, expect } from 'vitest';
import { chunk } from 'lodash-es';

test('chunk', () => { expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]); });

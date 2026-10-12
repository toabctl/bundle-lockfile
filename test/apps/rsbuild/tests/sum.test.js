// Run by Rstest (fixture rsbuild2.2-npm), which bundles the tests with Rsbuild: no lockfile in the project
import { expect, test } from '@rstest/core';

test('sum', () => {
  expect(1 + 1).toBe(2);
});

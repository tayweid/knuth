import assert from 'node:assert/strict';
import { findHeader, spliceHeader } from './header.ts';

const block = ['# /// script', '# dependencies = ["seaborn"]', '# ///'];

assert.deepEqual(findHeader(['#!/usr/bin/env python', ...block, '']), [1, 3]);
assert.equal(findHeader(['# /// script', '# unterminated']), null);
assert.equal(findHeader(['x = 1']), null);

// Replace in place, keeping what surrounds it.
assert.deepEqual(
  spliceHeader(['#!/usr/bin/env python', '# /// script', '# ///', '', '# note'], block),
  ['#!/usr/bin/env python', ...block, '', '# note'],
);
// No block: lead the preamble, separated by a blank line.
assert.deepEqual(spliceHeader(['# note', ''], block), [...block, '', '# note', '']);
assert.deepEqual(spliceHeader(['', '# note'], block), [...block, '', '# note']);
// Empty preamble: the block plus the blank line the cells expect above them.
assert.deepEqual(spliceHeader([], block), [...block, '']);
// Idempotent: splicing the same block twice changes nothing more.
const once = spliceHeader(['# note'], block);
assert.deepEqual(spliceHeader(once, block), once);
console.log('header.test: all assertions passed');

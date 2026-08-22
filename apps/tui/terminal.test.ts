import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { allowOwnedResizeListeners } from './terminal.js';

test('scopes the listener limit override to the Ink view lifetime', () => {
  const output = new EventEmitter();
  output.setMaxListeners(7);

  const restore = allowOwnedResizeListeners(output);
  assert.equal(output.getMaxListeners(), 0);

  restore();
  assert.equal(output.getMaxListeners(), 7);

  restore();
  assert.equal(output.getMaxListeners(), 7);
});

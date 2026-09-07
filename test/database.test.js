import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema, Table, column, SyncStreamConnectionMethod } from '../lib/index.js';
import { PowerSyncDatabase } from '../lib/PowerSyncDatabase.js';
import { LynxRemote } from '../lib/sync/LynxRemote.js';

test('barrel re-exports common names and default connect method is HTTP', () => {
  assert.equal(typeof Schema, 'function');
  assert.equal(typeof Table, 'function');
  assert.equal(typeof column.text, 'object');
  const getter = Object.getOwnPropertyDescriptor(PowerSyncDatabase.prototype, 'defaultConnectionMethod')?.get;
  assert.equal(typeof getter, 'function');
  assert.equal(getter.call({}), SyncStreamConnectionMethod.HTTP);
});

test('LynxRemote createTextDecoder uses TextCodecHelper UTF-8', () => {
  const decoded = [];
  globalThis.TextCodecHelper = {
    decode(buf) {
      decoded.push(buf);
      return new TextDecoder().decode(buf);
    }
  };
  const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
  const decoder = remote.createTextDecoder();
  const bytes = new TextEncoder().encode('hello');
  assert.equal(decoder.decode(bytes), 'hello');
  assert.equal(decoded.length, 1);
  assert.ok(decoded[0] instanceof ArrayBuffer);
});

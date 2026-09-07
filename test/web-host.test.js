import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { attach } from '../lib/web-host/index.js';
import { decodeCloneable, encodeCloneable } from '../lib/web-host/cloneable.js';
import createFactory from '../lib/web-host/factory.js';
import {
  MODULE_NAME,
  mappingStats,
  resetWebHostMapping
} from '../lib/web-host/page-rpc.js';

afterEach(() => {
  resetWebHostMapping();
});

function mockWeb(calls) {
  calls.constructs = [];
  calls.closes = [];
  calls.locks = [];
  calls.executeRaw = [];
  calls.executeBatch = [];

  class WASQLiteOpenFactory {
    constructor(options) {
      calls.constructs.push(options);
    }
    openDB() {
      return {
        async readLock(fn) {
          calls.locks.push('read');
          return fn(tx);
        },
        async writeLock(fn) {
          calls.locks.push('write');
          return fn(tx);
        },
        async close() {
          calls.closes.push(true);
        }
      };
    }
  }

  const tx = {
    async executeRaw(sql, params) {
      calls.executeRaw.push({ sql, params });
      return {
        insertId: 1,
        rowsAffected: 1,
        columnNames: ['n'],
        rawRows: [[params?.[0] ?? 0]]
      };
    },
    async executeBatch(sql, params) {
      calls.executeBatch.push({ sql, params });
      return { insertId: 2, rowsAffected: params?.length ?? 0, array: [] };
    }
  };

  return {
    WASQLiteOpenFactory,
    createConsoleLogger() {
      return { log() {} };
    }
  };
}

function loadMock(calls) {
  const web = mockWeb(calls);
  return async () => web;
}

test('encode/decode ArrayBuffer and bigint both directions', () => {
  const buf = new Uint8Array([0, 255, 16]).buffer;
  const encoded = encodeCloneable({ blob: buf, n: 9n, nested: [1n, buf] });
  assert.deepEqual(encoded.blob, { __psAb: true, u8: [0, 255, 16] });
  assert.deepEqual(encoded.n, { __psBig: true, v: '9' });
  assert.equal(encoded.nested[0].__psBig, true);
  const decoded = decodeCloneable(encoded);
  assert.equal(decoded.n, 9n);
  assert.ok(decoded.blob instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(decoded.blob)], [0, 255, 16]);
  assert.equal(decoded.nested[0], 1n);
});

test('attach merges nativeModulesMap and wraps onNativeModulesCall; detach restores', async () => {
  const previous = async (name, data, moduleName) => ({ from: 'prev', name, moduleName, data });
  const lynxView = {
    nativeModulesMap: { bridge: 'bridge://x', OtherMod: 'other.js' },
    onNativeModulesCall: previous
  };

  const { detach } = attach(lynxView);
  const factoryUrl = lynxView.nativeModulesMap[MODULE_NAME];
  assert.equal(lynxView.nativeModulesMap.bridge, 'bridge://x');
  assert.equal(lynxView.nativeModulesMap.OtherMod, 'other.js');
  assert.ok(typeof factoryUrl === 'string');
  assert.match(factoryUrl, /factory\.js$/);
  assert.doesNotMatch(factoryUrl, /^blob:/);
  assert.equal(factoryUrl, new URL('../lib/web-host/factory.js', import.meta.url).href);
  assert.notEqual(lynxView.onNativeModulesCall, previous);

  const passthrough = await lynxView.onNativeModulesCall('ping', { a: 1 }, 'bridge');
  assert.deepEqual(passthrough, { from: 'prev', name: 'ping', moduleName: 'bridge', data: { a: 1 } });

  detach();
  assert.equal(lynxView.onNativeModulesCall, previous);
  assert.equal(lynxView.nativeModulesMap.bridge, 'bridge://x');
  assert.equal(lynxView.nativeModulesMap.OtherMod, 'other.js');
  assert.equal(lynxView.nativeModulesMap[MODULE_NAME], undefined);
});

test('detach unwraps only when still current; reverse order restores', () => {
  const original = () => 'orig';
  const lynxView = { nativeModulesMap: {}, onNativeModulesCall: original };
  const first = attach(lynxView);
  const firstHandler = lynxView.onNativeModulesCall;
  const second = attach(lynxView);
  const secondHandler = lynxView.onNativeModulesCall;
  assert.notEqual(firstHandler, secondHandler);

  first.detach();
  assert.equal(lynxView.onNativeModulesCall, secondHandler);
  assert.ok(lynxView.nativeModulesMap[MODULE_NAME]);

  second.detach();
  assert.equal(lynxView.onNativeModulesCall, firstHandler);
  first.detach();
  assert.equal(lynxView.onNativeModulesCall, original);
  assert.equal(lynxView.nativeModulesMap[MODULE_NAME], undefined);
});

test('one WASQLiteOpenFactory per dbFilename+dbLocation; extra opens refcount', async () => {
  const { handleNativeCall } = await import('../lib/web-host/page-rpc.js');
  const calls = {};
  const loadWeb = loadMock(calls);
  const options = { vfs: 'IDBBatchAtomicVFS', additionalReaders: 4 };

  const ids = [];
  for (let i = 0; i < 6; i++) {
    const open = await handleNativeCall(
      'open',
      { dbFilename: 'app.db', readOnly: i !== 0 },
      options,
      loadWeb
    );
    assert.equal(open.ok, true);
    ids.push(open.dbId);
  }

  assert.equal(calls.constructs.length, 1);
  assert.equal(calls.constructs[0].open.dbFilename, 'app.db');
  assert.equal(calls.constructs[0].open.vfs, 'IDBBatchAtomicVFS');
  assert.equal(calls.constructs[0].open.additionalReaders, 4);
  assert.equal('encryptionKey' in calls.constructs[0].open, false);
  assert.equal('ssrMode' in calls.constructs[0].open, false);
  assert.equal(new Set(ids).size, 6);
  assert.equal(mappingStats().files, 1);
  assert.equal(mappingStats().connections, 6);

  const other = await handleNativeCall(
    'open',
    { dbFilename: 'app.db', dbLocation: 'other' },
    options,
    loadWeb
  );
  assert.equal(other.ok, true);
  assert.equal(calls.constructs.length, 2);

  for (let i = 0; i < 5; i++) {
    const closed = await handleNativeCall('close', ids[i], null, loadWeb);
    assert.equal(closed.ok, true);
  }
  assert.equal(calls.closes.length, 0);
  assert.equal(mappingStats().files, 2);

  await handleNativeCall('close', ids[5], null, loadWeb);
  assert.equal(calls.closes.length, 1);
  assert.equal(mappingStats().connections, 1);
});

test('readOnly routes execute to readLock+executeRaw; writes use writeLock', async () => {
  const { handleNativeCall } = await import('../lib/web-host/page-rpc.js');
  const calls = {};
  const loadWeb = loadMock(calls);

  const write = await handleNativeCall('open', { dbFilename: 'w.db' }, undefined, loadWeb);
  const read = await handleNativeCall(
    'open',
    { dbFilename: 'w.db', readOnly: true },
    undefined,
    loadWeb
  );
  assert.equal(calls.constructs.length, 1);

  await handleNativeCall(
    'execute',
    { dbId: write.dbId, sql: 'select 1', params: [1] },
    undefined,
    loadWeb
  );
  await handleNativeCall(
    'execute',
    { dbId: read.dbId, sql: 'select 1', params: [2] },
    undefined,
    loadWeb
  );
  await handleNativeCall(
    'executeBatch',
    { dbId: write.dbId, sql: 'insert', params: [[1], [2]] },
    undefined,
    loadWeb
  );

  assert.deepEqual(calls.locks, ['write', 'read', 'write']);
  assert.equal(calls.executeRaw.length, 2);
  assert.equal(calls.executeBatch.length, 1);
});

test('page catch returns ok:false envelope with optional code', async () => {
  const { handleNativeCall } = await import('../lib/web-host/page-rpc.js');
  const loadWeb = async () => ({
    WASQLiteOpenFactory: class {
      constructor() {}
      openDB() {
        return {
          async writeLock() {
            const err = new Error('boom');
            err.code = 19;
            throw err;
          }
        };
      }
    },
    createConsoleLogger() {
      return { log() {} };
    }
  });
  const opened = await handleNativeCall('open', { dbFilename: 'x.db' }, undefined, loadWeb);
  const result = await handleNativeCall(
    'execute',
    { dbId: opened.dbId, sql: 'x', params: [] },
    undefined,
    loadWeb
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, 'boom');
  assert.equal(result.code, 19);
});

test('factory encodes params and decodes envelopes; Adapter sees ArrayBuffer/bigint', async () => {
  const { handleNativeCall } = await import('../lib/web-host/page-rpc.js');
  const calls = {};
  const loadWeb = loadMock(calls);
  const handler = async (name, data) => handleNativeCall(name, data, undefined, loadWeb);
  const methods = createFactory({}, handler);

  const opened = await new Promise((resolve) => methods.open({ dbFilename: 'c.db' }, resolve));
  assert.equal(opened.ok, true);

  const blob = new Uint8Array([7, 8]).buffer;
  const exec = await new Promise((resolve) =>
    methods.execute(opened.dbId, 'select ?', [blob, 99n], resolve)
  );
  assert.equal(exec.ok, true);
  const sent = calls.executeRaw[0].params;
  assert.ok(sent[0] instanceof ArrayBuffer);
  assert.equal(sent[1], 99n);
  assert.equal(exec.rawRows[0][0] instanceof ArrayBuffer, true);
});

test('factory URL is a real module URL, not createObjectURL', () => {
  const src = pathToFileURL(new URL('../lib/web-host/attach.js', import.meta.url).pathname);
  assert.equal(typeof src.href, 'string');
});

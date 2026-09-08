import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function peExports(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} is not a PE file`);
  }
  const eLfanew = buf.readUInt32LE(0x3c);
  const coff = eLfanew + 4;
  const nSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const machine = buf.readUInt16LE(coff);
  const dataDirOff = magic === 0x20b ? opt + 112 : opt + 96;
  const exportRva = buf.readUInt32LE(dataDirOff);
  const sections = [];
  const secStart = opt + optSize;
  for (let i = 0; i < nSections; i += 1) {
    const o = secStart + i * 40;
    sections.push({
      va: buf.readUInt32LE(o + 12),
      vsize: buf.readUInt32LE(o + 8),
      rawSize: buf.readUInt32LE(o + 16),
      rawPtr: buf.readUInt32LE(o + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
        return s.rawPtr + (rva - s.va);
      }
    }
    return null;
  };
  const names = [];
  if (exportRva) {
    const exp = rvaToOff(exportRva);
    const nNames = buf.readUInt32LE(exp + 24);
    const namesRva = buf.readUInt32LE(exp + 32);
    for (let i = 0; i < nNames; i += 1) {
      const nrva = buf.readUInt32LE(rvaToOff(namesRva) + i * 4);
      let o = rvaToOff(nrva);
      let s = '';
      while (buf[o] !== 0) {
        s += String.fromCharCode(buf[o]);
        o += 1;
      }
      names.push(s);
    }
  }
  return { machine, magic, names, bytes: buf };
}

const macos = path.join(ROOT, 'dist/macos/arm64/powersync-lynx.node');
const win = path.join(ROOT, 'dist/windows/x64/powersync-lynx.node');
const winDll = path.join(ROOT, 'dist/windows/x64/powersync_x64.dll');
const macDylib = path.join(
  ROOT,
  'dist/macos/arm64/libpowersync_aarch64.macos.dylib',
);

if (!fs.existsSync(macos)) fail('missing dist/macos/arm64/powersync-lynx.node');
else ok('macos arm64 node present');
if (!fs.existsSync(macDylib)) fail('missing macos powersync-sqlite-core dylib');
else ok('macos core dylib present');
if (!fs.existsSync(win)) fail('missing dist/windows/x64/powersync-lynx.node');
else ok('windows x64 node present');
if (!fs.existsSync(winDll)) fail('missing windows powersync_x64.dll');
else ok('windows core dll present');

if (fs.existsSync(macos)) {
  const buf = fs.readFileSync(macos);
  if (buf.slice(0, 4).toString('hex') !== 'cffaedfe') {
    fail('macos node is not Mach-O');
  } else {
    ok('macos node is Mach-O');
  }
  for (const needle of ['napi_register_module_v1', 'NativePowerSyncModule', 'sqlite3_open_v2']) {
    if (!buf.includes(Buffer.from(needle))) fail(`macos node missing ${needle}`);
    else ok(`macos node contains ${needle}`);
  }
}

if (fs.existsSync(win)) {
  const pe = peExports(win);
  if (pe.machine !== 0x8664) fail(`windows node machine ${pe.machine.toString(16)} != amd64`);
  else ok('windows node is PE x64');
  if (!pe.names.includes('napi_register_module_v1')) {
    fail(`windows node missing export napi_register_module_v1 (got ${pe.names.join(',')})`);
  } else {
    ok('windows node exports napi_register_module_v1');
  }
  if (!pe.bytes.includes(Buffer.from('NativePowerSyncModule'))) {
    fail('windows node missing NativePowerSyncModule lookup string');
  } else {
    ok('windows node contains NativePowerSyncModule');
  }
  if (!pe.bytes.includes(Buffer.from('sqlite3_load_extension'))) {
    fail('windows node missing sqlite3_load_extension');
  } else {
    ok('windows node contains sqlite3_load_extension');
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log('all Autolink artifact checks passed');

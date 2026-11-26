import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MACHO_MAGIC_64_LE = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const PE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function parseMachO64(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 16) {
    throw new Error(`${filePath} is too small to be a Mach-O binary`);
  }
  const magic = buf.readUInt32LE(0);
  const cpuType = buf.readUInt32LE(4);
  return { magic, cpuType, bytes: buf };
}

function parsePe(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} is not a PE file`);
  }
  const eLfanew = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', eLfanew, eLfanew + 4) !== 'PE\0\0') {
    throw new Error(`${filePath} has an invalid PE signature`);
  }
  const coff = eLfanew + 4;
  const machine = buf.readUInt16LE(coff);
  const nSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const dataDirOff = magic === PE32_PLUS_MAGIC ? opt + 112 : opt + 96;
  const exportRva = buf.readUInt32LE(dataDirOff);
  const importRva = buf.readUInt32LE(dataDirOff + 8);
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
  const readCString = (offset) => {
    let o = offset;
    let s = '';
    while (o < buf.length && buf[o] !== 0) {
      s += String.fromCharCode(buf[o]);
      o += 1;
    }
    return s;
  };

  const exports = [];
  if (exportRva) {
    const exp = rvaToOff(exportRva);
    if (exp !== null) {
      const nNames = buf.readUInt32LE(exp + 24);
      const namesRva = buf.readUInt32LE(exp + 32);
      const namesOff = rvaToOff(namesRva);
      if (namesOff !== null) {
        for (let i = 0; i < nNames; i += 1) {
          const nrva = buf.readUInt32LE(namesOff + i * 4);
          const off = rvaToOff(nrva);
          if (off !== null) {
            exports.push(readCString(off));
          }
        }
      }
    }
  }

  const imports = [];
  if (importRva) {
    let desc = rvaToOff(importRva);
    while (desc !== null && desc + 20 <= buf.length) {
      const origFirstThunk = buf.readUInt32LE(desc);
      const nameRva = buf.readUInt32LE(desc + 12);
      const firstThunk = buf.readUInt32LE(desc + 16);
      if (origFirstThunk === 0 && nameRva === 0 && firstThunk === 0) {
        break;
      }
      const dllOff = rvaToOff(nameRva);
      const dllName = dllOff !== null ? readCString(dllOff) : '';
      const thunkRva = origFirstThunk || firstThunk;
      const thunkOff = rvaToOff(thunkRva);
      const symbols = [];
      if (thunkOff !== null) {
        const step = magic === PE32_PLUS_MAGIC ? 8 : 4;
        for (let p = thunkOff; p + step <= buf.length; p += step) {
          const val = magic === PE32_PLUS_MAGIC ? buf.readBigUInt64LE(p) : BigInt(buf.readUInt32LE(p));
          if (val === 0n) {
            break;
          }
          const ordinalFlag = magic === PE32_PLUS_MAGIC ? 1n << 63n : 1n << 31n;
          if ((val & ordinalFlag) === 0n) {
            const hintNameOff = rvaToOff(Number(val & 0xffffffffn));
            if (hintNameOff !== null && hintNameOff + 2 < buf.length) {
              symbols.push(readCString(hintNameOff + 2));
            }
          }
        }
      }
      imports.push({ dllName, symbols });
      desc += 20;
    }
  }

  return { machine, magic, exports, imports, bytes: buf };
}

function checkMacos() {
  const macos = path.join(ROOT, 'dist/macos/arm64/powersync-lynx.node');
  const macDylib = path.join(ROOT, 'dist/macos/arm64/libpowersync_aarch64.macos.dylib');

  if (!fs.existsSync(macos)) {
    fail('missing dist/macos/arm64/powersync-lynx.node');
  } else {
    ok('macos arm64 node present');
    const macho = parseMachO64(macos);
    if (macho.magic !== MACHO_MAGIC_64_LE) {
      fail('macos node is not 64-bit Mach-O');
    } else if (macho.cpuType !== CPU_TYPE_ARM64) {
      fail(`macos node cpuType 0x${macho.cpuType.toString(16)} != arm64`);
    } else {
      ok('macos node is Mach-O arm64');
    }
    for (const needle of [
      'napi_register_module_v1',
      'node_api_module_get_api_version_v1',
      'NativePowerSyncModule',
      'sqlite3_open_v2',
      'sqlite3_powersync_init',
      'lynx_env_register_native_module',
    ]) {
      if (!macho.bytes.includes(Buffer.from(needle))) {
        fail(`macos node missing ${needle}`);
      } else {
        ok(`macos node contains ${needle}`);
      }
    }
  }

  if (!fs.existsSync(macDylib)) {
    fail('missing macos powersync-sqlite-core dylib');
  } else {
    ok('macos core dylib present');
    const macho = parseMachO64(macDylib);
    if (macho.magic !== MACHO_MAGIC_64_LE || macho.cpuType !== CPU_TYPE_ARM64) {
      fail('macos core dylib is not Mach-O arm64');
    } else {
      ok('macos core dylib is Mach-O arm64');
    }
  }
}

function checkWindows() {
  const win = path.join(ROOT, 'dist/windows/x64/powersync-lynx.node');
  const winDll = path.join(ROOT, 'dist/windows/x64/powersync_x64.dll');

  if (!fs.existsSync(win)) {
    fail('missing dist/windows/x64/powersync-lynx.node');
  } else {
    ok('windows x64 node present');
    const pe = parsePe(win);
    if (pe.machine !== PE_MACHINE_AMD64 || pe.magic !== PE32_PLUS_MAGIC) {
      fail(
        `windows node machine=0x${pe.machine.toString(16)} magic=0x${pe.magic.toString(16)} != PE32+ x64`,
      );
    } else {
      ok('windows node is PE32+ x64');
    }
    for (const exp of ['napi_register_module_v1', 'node_api_module_get_api_version_v1']) {
      if (!pe.exports.includes(exp)) {
        fail(`windows node missing export ${exp} (got ${pe.exports.join(',')})`);
      } else {
        ok(`windows node exports ${exp}`);
      }
    }
    for (const needle of [
      'NativePowerSyncModule',
      'sqlite3_powersync_init',
      'sqlite3_load_extension',
      'lynx_env_register_native_module',
    ]) {
      const inImports = pe.imports.some((imp) => imp.symbols.includes(needle));
      if (!inImports && !pe.bytes.includes(Buffer.from(needle))) {
        fail(`windows node missing ${needle}`);
      } else {
        ok(`windows node references ${needle}`);
      }
    }
  }

  if (!fs.existsSync(winDll)) {
    fail('missing windows powersync_x64.dll');
  } else {
    ok('windows core dll present');
    const dllPe = parsePe(winDll);
    if (dllPe.machine !== PE_MACHINE_AMD64 || dllPe.magic !== PE32_PLUS_MAGIC) {
      fail('windows core dll is not PE32+ x64');
    } else {
      ok('windows core dll is PE32+ x64');
    }
    if (!dllPe.exports.includes('sqlite3_powersync_init')) {
      fail('windows core dll missing export sqlite3_powersync_init');
    } else {
      ok('windows core dll exports sqlite3_powersync_init');
    }
  }
}

const args = process.argv.slice(2);
let wantMacos = false;
let wantWindows = false;
for (const arg of args) {
  if (arg === '--macos') {
    wantMacos = true;
  } else if (arg === '--windows') {
    wantWindows = true;
  } else {
    console.error(`Unknown argument: ${arg}. Expected --macos and/or --windows`);
    process.exit(1);
  }
}
if (!wantMacos && !wantWindows) {
  wantMacos = true;
  wantWindows = true;
}

if (wantMacos) {
  checkMacos();
}
if (wantWindows) {
  checkWindows();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log('all Autolink artifact checks passed');

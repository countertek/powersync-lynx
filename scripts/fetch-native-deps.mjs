import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_YEAR = '2026';
const SQLITE_AMALGAMATION = 'sqlite-amalgamation-3510200';
const SQLITE_URL = `https://www.sqlite.org/${SQLITE_YEAR}/${SQLITE_AMALGAMATION}.zip`;
const CORE_VERSION = '0.5.3';
const CORE_BASE = `https://github.com/powersync-ja/powersync-sqlite-core/releases/download/v${CORE_VERSION}`;

const CORE_ASSETS = {
  'libpowersync_aarch64.macos.dylib':
    '4fa96a98d7edb64a188493beb277bddcb7e85b286e2533d685ecf49ff51c6807',
  'libpowersync_x64.macos.dylib':
    '1209f802bcd886a112bd0de9ca5d7497a62af045fc64b78e703bdd465ee40979',
  'powersync_x64.dll':
    'b3f62293f26d3ee309880d30e1e54819ac21b4d0b1ba9b9177f92e1dcbfdb0c7',
  'powersync_x86.dll':
    'd2403446c5b2d0550eb99cb195db01798ef78a740ba4f462cd0b887e0ce4bd8a',
  'powersync_aarch64.dll':
    '19afce715bf63b4f590fb2c00d18c3681b818cd6eee5a35284bd3a804f090b20',
};

async function sha256File(filePath) {
  try {
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed ${response.status} ${url}`);
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
}

function materializeRegularFile(src, dest) {
  try {
    fs.lstatSync(dest);
    fs.unlinkSync(dest);
  } catch {
    // dest does not exist
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function materializeIosSrcCompileInputs() {
  const iosSrc = path.join(ROOT, 'ios', 'src');
  const sqliteDir = path.join(ROOT, 'third_party', 'sqlite');
  materializeRegularFile(path.join(ROOT, 'shared', 'ps_sql.cc'), path.join(iosSrc, 'ps_sql.cc'));
  materializeRegularFile(path.join(ROOT, 'shared', 'ps_sql.h'), path.join(iosSrc, 'ps_sql.h'));
  materializeRegularFile(path.join(sqliteDir, 'sqlite3.c'), path.join(iosSrc, 'sqlite3.c'));
  materializeRegularFile(path.join(sqliteDir, 'sqlite3.h'), path.join(iosSrc, 'sqlite3.h'));
}

async function ensureSqlite() {
  const dir = path.join(ROOT, 'third_party', 'sqlite');
  const header = path.join(dir, 'sqlite3.h');
  const source = path.join(dir, 'sqlite3.c');
  if (fs.existsSync(header) && fs.existsSync(source)) {
    console.log('sqlite amalgamation present');
    materializeIosSrcCompileInputs();
    return;
  }
  const zipPath = path.join(ROOT, 'third_party', `${SQLITE_AMALGAMATION}.zip`);
  console.log(`downloading ${SQLITE_URL}`);
  await download(SQLITE_URL, zipPath);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', zipPath, '-d', path.join(ROOT, 'third_party')], {
    stdio: 'inherit',
  });
  const extracted = path.join(ROOT, 'third_party', SQLITE_AMALGAMATION);
  fs.copyFileSync(path.join(extracted, 'sqlite3.c'), source);
  fs.copyFileSync(path.join(extracted, 'sqlite3.h'), header);
  fs.copyFileSync(path.join(extracted, 'sqlite3ext.h'), path.join(dir, 'sqlite3ext.h'));
  console.log('sqlite amalgamation ready');
  materializeIosSrcCompileInputs();
}

async function ensureCoreAsset(name, destDir) {
  const expected = CORE_ASSETS[name];
  const dest = path.join(destDir, name);
  const current = await sha256File(dest);
  if (current === expected) {
    console.log(`${name} up to date`);
    return dest;
  }
  const url = `${CORE_BASE}/${name}`;
  console.log(`downloading ${url}`);
  await download(url, dest);
  const after = await sha256File(dest);
  if (after !== expected) {
    throw new Error(`hash mismatch for ${name}: ${after}`);
  }
  return dest;
}

async function main() {
  await ensureSqlite();
  if (process.argv.includes("--sqlite")) {
    return;
  }
  await ensureCoreAsset(
    'libpowersync_aarch64.macos.dylib',
    path.join(ROOT, 'dist', 'macos', 'arm64'),
  );
  await ensureCoreAsset(
    'libpowersync_x64.macos.dylib',
    path.join(ROOT, 'dist', 'macos', 'x64'),
  );
  await ensureCoreAsset(
    'powersync_x64.dll',
    path.join(ROOT, 'dist', 'windows', 'x64'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

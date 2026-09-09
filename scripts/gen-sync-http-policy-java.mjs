import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HEADER_PATH = path.join(ROOT, 'shared', 'sync_http_policy.h');
export const JAVA_PATH = path.join(
  ROOT,
  'android',
  'src',
  'main',
  'java',
  'com',
  'powersync',
  'lynx',
  'SyncHttpPolicy.java',
);
const MACRO_PREFIX = 'PS_SYNC_HTTP_';

/**
 * @typedef {{ kind: 'int', value: number } | { kind: 'string', value: string }} PolicyValue
 */

/**
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\' && i + 1 < source.length) {
          out += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(i + 2, source.length);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} raw
 * @returns {PolicyValue}
 */
function parseLiteral(raw) {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return { kind: 'string', value: raw.slice(1, -1) };
  }
  const normalized = raw.replaceAll('_', '').replace(/[Ll]$/, '');
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`unsupported policy literal: ${raw}`);
  }
  return { kind: 'int', value: Number.parseInt(normalized, 10) };
}

/**
 * @param {string} source
 * @returns {Map<string, PolicyValue>}
 */
export function parseHeaderMacros(source) {
  const macros = new Map();
  for (const line of stripComments(source).split(/\r?\n/)) {
    const match = /^\s*#define\s+(PS_SYNC_HTTP_[A-Z0-9_]+)\s+(\S+)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    macros.set(match[1].slice(MACRO_PREFIX.length), parseLiteral(match[2]));
  }
  if (macros.size === 0) {
    throw new Error('no PS_SYNC_HTTP_ object macros in header');
  }
  return macros;
}

/**
 * @param {string} source
 * @returns {Map<string, PolicyValue>}
 */
export function parseJavaConstants(source) {
  const constants = new Map();
  const body = stripComments(source);
  const pattern =
    /static\s+final\s+(long|String)\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g;
  let match = pattern.exec(body);
  while (match !== null) {
    constants.set(match[2], parseLiteral(match[3].trim()));
    match = pattern.exec(body);
  }
  if (constants.size === 0) {
    throw new Error('no static final policy constants in Java');
  }
  return constants;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatJavaLong(value) {
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  return `${sign}${grouped}L`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeJava(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * @param {Map<string, PolicyValue>} macros
 * @returns {string}
 */
export function generateJava(macros) {
  const fields = [];
  for (const [name, parsed] of macros) {
    if (parsed.kind === 'int') {
      fields.push(`  static final long ${name} = ${formatJavaLong(parsed.value)};`);
    } else {
      fields.push(`  static final String ${name} = "${escapeJava(parsed.value)}";`);
    }
  }
  return `package com.powersync.lynx;

/**
 * Generated from {@code shared/sync_http_policy.h}. Do not edit.
 *
 * <p>Regenerate with {@code node scripts/gen-sync-http-policy-java.mjs}.
 * Linux {@code make test} fails if these constants drift from the header.
 */
final class SyncHttpPolicy {
${fields.join('\n')}

  private SyncHttpPolicy() {}
}
`;
}

/**
 * @param {Map<string, PolicyValue>} left
 * @param {Map<string, PolicyValue>} right
 * @param {string} leftName
 * @param {string} rightName
 * @returns {string[]}
 */
export function diffPolicyMaps(left, right, leftName, rightName) {
  const errors = [];
  const names = new Set([...left.keys(), ...right.keys()]);
  const sorted = [...names].sort();
  for (const name of sorted) {
    const a = left.get(name);
    const b = right.get(name);
    if (a === undefined) {
      errors.push(`${name}: missing in ${leftName}`);
      continue;
    }
    if (b === undefined) {
      errors.push(`${name}: missing in ${rightName}`);
      continue;
    }
    if (a.kind !== b.kind || a.value !== b.value) {
      errors.push(`${name}: ${leftName}=${JSON.stringify(a)} ${rightName}=${JSON.stringify(b)}`);
    }
  }
  return errors;
}

function main(argv) {
  const checkOnly = argv.includes('--check');
  const header = fs.readFileSync(HEADER_PATH, 'utf8');
  const generated = generateJava(parseHeaderMacros(header));
  if (checkOnly) {
    if (!fs.existsSync(JAVA_PATH)) {
      console.error(`FAIL: missing ${JAVA_PATH}`);
      process.exit(1);
    }
    const existing = fs.readFileSync(JAVA_PATH, 'utf8');
    const semantic = diffPolicyMaps(
      parseHeaderMacros(header),
      parseJavaConstants(existing),
      'header',
      'java',
    );
    if (semantic.length > 0) {
      for (const error of semantic) {
        console.error(`FAIL: ${error}`);
      }
      process.exit(1);
    }
    if (existing !== generated) {
      console.error(`FAIL: ${path.relative(ROOT, JAVA_PATH)} is stale; regenerate`);
      process.exit(1);
    }
    console.log('ok: SyncHttpPolicy.java matches shared/sync_http_policy.h');
    return;
  }
  fs.mkdirSync(path.dirname(JAVA_PATH), { recursive: true });
  fs.writeFileSync(JAVA_PATH, generated);
  console.log(`wrote ${path.relative(ROOT, JAVA_PATH)}`);
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main(process.argv.slice(2));
}

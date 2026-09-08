'use strict';

const path = require('node:path');

function normalizePlatform(platform) {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return platform;
  }
}

const nativeBinding = require(path.join(
  __dirname,
  '..',
  'dist',
  normalizePlatform(process.platform),
  process.arch,
  'powersync-lynx.node',
));

if (typeof nativeBinding.initialize !== 'function') {
  nativeBinding.initialize = function initialize() {};
}

module.exports = nativeBinding;
module.exports.default = nativeBinding;

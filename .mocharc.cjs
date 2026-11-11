// SPDX-License-Identifier: AGPL-3.0-or-later
// Read by every mocha run started in this folder or in one below it: `npm run test:unit`, and a bare
// `npx mocha <file>`. (vscode-test's hosts do not read it; scripts/run-tests.mjs is their door.)
const path = require('node:path');

module.exports = {
  // T-81: the run owns its temp folders and removes them when it ends (scripts/test-tmp.mjs). Before
  // this, every unit run left 390 folders in the machine's temp folder. The path is absolute because
  // mocha resolves a relative one against the folder mocha was started in, not against this file.
  require: [path.join(__dirname, 'scripts', 'mocha-test-tmp.mjs')],
};

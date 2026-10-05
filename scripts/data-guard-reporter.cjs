const path = require('path');
const { snapshotDataTree, diffDataTrees } = require('./data-guard.cjs');

/**
 * Fails the Jest run when anything under data/ changes.
 * Tests that need sets or stats write them under JEV_DATA_DIR (see scripts/jest-env.cjs).
 */
class DataGuardReporter {
  constructor() {
    this.error = undefined;
    this.before = {};
  }

  onRunStart() {
    this.before = snapshotDataTree(path.resolve(process.cwd(), 'data'));
  }

  onRunComplete() {
    const after = snapshotDataTree(path.resolve(process.cwd(), 'data'));
    const changes = diffDataTrees(this.before, after);
    if (changes.length === 0) return;
    const message = `data guard: data/ changed during tests:\n${changes.map(line => `  ${line}`).join('\n')}`;
    console.error(message);
    this.error = new Error(message);
  }

  getLastError() {
    return this.error;
  }
}

module.exports = DataGuardReporter;

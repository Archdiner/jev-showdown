const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Relative path -> sha256 of file bytes. Missing directories snapshot as {}.
 * Used by the Jest reporter so a test that writes data/ fails the run.
 */
function snapshotDataTree(dir) {
  const root = path.resolve(dir);
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = path.relative(root, full);
      const bytes = fs.readFileSync(full);
      out[rel] = crypto.createHash('sha256').update(bytes).digest('hex');
    }
  };
  walk(root);
  return out;
}

function diffDataTrees(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (!(key in before)) changes.push(`added ${key}`);
    else if (!(key in after)) changes.push(`removed ${key}`);
    else if (before[key] !== after[key]) changes.push(`changed ${key}`);
  }
  return changes;
}

module.exports = { snapshotDataTree, diffDataTrees };

#!/usr/bin/env node
import * as path from 'path';
import { buildCalibrationReport } from '../analysis/calibration.js';

const args = process.argv.slice(2);
let dir = 'logs/ladder';
let asJson = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--log-dir') dir = args[++i] || dir;
  else if (arg === '--json') asJson = true;
  else if (arg === '--help') {
    console.log('Usage: npm run calibration -- [--log-dir logs/ladder] [--json]');
    process.exit(0);
  } else {
    console.error(`Unknown argument ${arg}`);
    console.error('Usage: npm run calibration -- [--log-dir logs/ladder] [--json]');
    process.exit(1);
  }
}

const report = buildCalibrationReport(path.resolve(dir));
if (asJson) {
  console.log(JSON.stringify({ summary: report.summary, byEngine: report.byEngine }, null, 2));
} else {
  console.log(report.text);
}

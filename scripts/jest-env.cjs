const fs = require('fs');
const os = require('os');
const path = require('path');
const { clearProviderKeys, installFetchStub } = require('./network-guard.cjs');

// Provider keys are cleared before any test module reads them.
clearProviderKeys();
installFetchStub();

// One temp dir per Jest worker. Tests must write sets and stats here, never to data/.
const dir = path.join(os.tmpdir(), `jev-data-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.env.JEV_DATA_DIR = dir;
process.env.JEV_ALLOW_SMALL_DATA = '1';

#!/usr/bin/env node
// Stage the application files (no Node runtime, no installer) into a directory.
// Shared by the macOS and Windows installer builds so the payload is identical.
//
//   node scripts/stage-app.mjs <destDir>
//
// Copies exactly what the connector needs to run: connector.mjs at the root
// (its imports are relative to it), src/, vendor/, plus package.json and docs.
// Zero-dependency — uses only node: builtins.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.argv[2];
if (!dest) {
  console.error('usage: node scripts/stage-app.mjs <destDir>');
  process.exit(2);
}

const ITEMS = ['connector.mjs', 'package.json', 'README.md', 'LICENSE', 'src', 'vendor'];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const item of ITEMS) {
  cpSync(join(root, item), join(dest, item), { recursive: true });
}
console.error(`[stage-app] staged ${ITEMS.length} items → ${dest}`);

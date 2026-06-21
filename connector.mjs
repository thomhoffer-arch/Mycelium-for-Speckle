#!/usr/bin/env node
// Mycelium connector for Speckle (v0.1).
// Exposes Speckle objects as Connective Spine records — live, via Speckle's
// GraphQL API.
//
//   node connector.mjs                 # full conformance report → stdout
//   node connector.mjs --jsonl         # one spine record per line (for piping)
//   node connector.mjs --out spine.json
//
// Open to extend: the property→spine mapping lives in src/speckle-client.mjs
// (pass your own mapObject / isElement / extractIfcGuid). The full Speckle
// object payload is kept on record.raw, so nothing is ever lost. For push
// updates, run the webhook receiver in src/webhook.mjs.

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { runAdapter, deriveIfcGuid } from './vendor/mycelium-sdk.mjs';
import { fetchSpeckle } from './src/speckle-client.mjs';

// True when this module is the process entry point. Resolves symlinks so it
// still fires when launched via an npm-linked/installed bin (where argv[1] is a
// symlink but import.meta.url is realpath-resolved).
function isEntryPoint(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  if (argv1 === self) return true;
  try { return realpathSync(argv1) === self; } catch { return false; }
}

export const config = {
  source: 'speckle',
  identity: {
    uniqueId: 'speckle:{project}:{id}',
    projectKey: '{project}',
    localIdField: 'id',
  },
  freshness: {
    revisionId: '{version}', // Speckle version (commit) id
    asOf: '{modified}',      // version createdAt
    confidence: 'live',      // pulled live from the API
  },
  // Optional fuzzy join edges scanned from each object's text.
  // Extend with your project's identifiers.
  extract: {
    deterministic: [
      { edge: 'po', regex: 'PUR-ORD-\\d{4}-\\d{5}' },
      { edge: 'nlsfb', regex: '\\b\\d{2}\\.\\d{2}\\b' },
      { edge: 'bcf', regex: 'B-\\d{3}' },
    ],
  },
};

// Wraps the Speckle client; reads connection details from the environment.
export function fetchSource(overrides = {}) {
  const env = process.env;
  return fetchSpeckle({
    server: env.SPECKLE_SERVER,        // default https://app.speckle.systems
    token: env.SPECKLE_TOKEN,          // Personal Access Token (scope: Streams read)
    projectId: env.SPECKLE_PROJECT_ID, // a.k.a. stream id
    modelId: env.SPECKLE_MODEL_ID,     // a.k.a. branch; its latest version is read
    objectId: env.SPECKLE_OBJECT_ID,   // optional: read one specific object instead
    deriveIfcGuid,
    ...overrides,
  });
}

// CLI entry — runs only when invoked directly, not when imported by tests.
if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`mycelium-for-speckle — expose Speckle objects as Connective Spine records

Usage:
  mycelium-for-speckle [options]

Options:
  --jsonl            Emit one spine record per line (for piping)
  --out <file>       Write the full report to <file> instead of stdout
  -h, --help         Show this help
  -v, --version      Show the version

Environment (for live reads — omit all to run the offline demo):
  SPECKLE_SERVER     Speckle server URL (default https://app.speckle.systems)
  SPECKLE_TOKEN      Personal Access Token (scope: Streams read)
  SPECKLE_PROJECT_ID Project (stream) id
  SPECKLE_MODEL_ID   Model (branch) id — its latest version is read
  SPECKLE_OBJECT_ID  Optional: read one object instead of a model's latest version

Push-live webhook receiver:
  mycelium-for-speckle-webhook            # listens on :3000 (set PORT to change)

Docs: https://github.com/thomhoffer-arch/Mycelium-for-Speckle`);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    process.exit(0);
  }

  const outFile = flag('--out');
  const jsonl = args.includes('--jsonl');

  const result = await runAdapter(config, { fetchSource: () => fetchSource() });

  const text = jsonl
    ? result.records.map((r) => JSON.stringify({ identity: r.identity, freshness: r.freshness })).join('\n')
    : JSON.stringify(result, null, 2);

  if (outFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outFile, text + (jsonl ? '\n' : ''));
    console.error(`[mycelium-for-speckle] wrote ${result.records.length} records → ${outFile}`);
  } else {
    console.log(text);
  }
  process.exit(result.conformant ? 0 : 1);
}

// Push-live webhook receiver for Speckle → Mycelium (zero-dep, node:http).
//
// Speckle fires a webhook on every new version. Point one at this endpoint
// (Speckle project settings → Webhooks) and it re-pulls the changed model and
// emits fresh spine records — no polling.
//
//   SPECKLE_TOKEN=... SPECKLE_SERVER=... node src/webhook.mjs       # listens on :3000
//
// By default it prints the conformance result; pass your own `onRecords` to
// forward records to an orchestrator (Mycelium Studio), a queue, a file, etc.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { runAdapter, deriveIfcGuid } from '../vendor/mycelium-sdk.mjs';
import { fetchSpeckle } from './speckle-client.mjs';
import { config } from '../connector.mjs';

// Constant-time secret comparison — avoids leaking the secret via response
// timing. Returns false on any type/length mismatch (timingSafeEqual throws on
// unequal lengths, so length is checked first).
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhookServer({
  server = process.env.SPECKLE_SERVER,
  token = process.env.SPECKLE_TOKEN,
  secret = process.env.SPECKLE_WEBHOOK_SECRET, // optional shared secret
  port = Number(process.env.PORT) || 3000,
  onRecords = (result) => console.log(JSON.stringify(result, null, 2)),
  fetchImpl,
} = {}) {
  const http = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const evt = body ? JSON.parse(body) : {};

        if (secret) {
          const provided = req.headers['x-webhook-secret'] || evt.secret || evt.payload?.secret;
          if (!secretsMatch(provided, secret)) { res.writeHead(401).end('bad secret'); return; }
        }

        // Speckle payload shapes vary by server version — read defensively.
        const p = evt.payload || evt;
        const projectId =
          p.streamId || p.projectId || p.stream?.id || p.project?.id || process.env.SPECKLE_PROJECT_ID;
        const modelId =
          p.branchName || p.modelId || p.branch?.id || p.model?.id || process.env.SPECKLE_MODEL_ID;

        if (!projectId) { res.writeHead(202).end('no project in payload; ignored'); return; }

        const rows = await fetchSpeckle({ server, token, projectId, modelId, deriveIfcGuid, fetchImpl });
        const result = await runAdapter(config, { fetchSource: () => Promise.resolve(rows) });
        await onRecords(result, { projectId, modelId, event: evt });

        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, conformant: result.conformant, records: result.records.length }));
      } catch (e) {
        res.writeHead(500).end(String(e?.message || e));
      }
    });
  });
  http.listen(port, () => console.error(`[mycelium-for-speckle] webhook listening on :${port}`));
  return http;
}

// CLI entry — runs only when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createWebhookServer();
}

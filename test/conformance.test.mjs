import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, deriveIfcGuid } from '../vendor/mycelium-sdk.mjs';
import { config, fetchSource } from '../connector.mjs';
import { fetchSpeckle } from '../src/speckle-client.mjs';
import { createWebhookServer } from '../src/webhook.mjs';

// 1. Offline mock: connector builds & conforms with zero setup.
test('mock fetch → conformant live spine records', async () => {
  const result = await runAdapter(config, {
    fetchSource: () => fetchSource({ token: undefined, projectId: undefined }),
  });
  assert.equal(result.source, 'speckle');
  assert.equal(result.conformant, true);
  assert.equal(result.records.length, 2); // mesh filtered out
  for (const r of result.records) {
    assert.match(r.identity.uniqueId, /^speckle:/);
    assert.equal(r.freshness.confidence, 'live');
  }
  assert.ok(result.records.every((r) => typeof r.identity.ifcGuid === 'string'));
});

// 2. Real GraphQL path against a faked Speckle server (no network).
test('graphql fetch → flattens objects & derives identity', async () => {
  const rows = await fetchSpeckle({
    server: 'https://example.speckle',
    token: 'pat',
    projectId: 'PRJ1',
    modelId: 'MDL1',
    deriveIfcGuid,
    fetchImpl: fakeFetch,
  });
  assert.equal(rows.length, 2); // root Collection filtered; wall + door kept
  assert.ok(rows.every((r) => r.project === 'PRJ1'));
  assert.ok(rows.every((r) => r.projectName === 'Sample Project'));
  assert.ok(rows.every((r) => typeof r.ifcGuid === 'string' && r.ifcGuid.length === 22));

  const result = await runAdapter(config, { fetchSource: () => Promise.resolve(rows) });
  assert.equal(result.conformant, true);
});

// 3. Webhook receiver re-syncs on a posted event.
test('webhook receiver → re-syncs and emits records', async () => {
  const got = [];
  const srv = createWebhookServer({
    server: 'https://example.speckle', token: 'pat', secret: 's3cret',
    port: 0, fetchImpl: fakeFetch, onRecords: (result) => { got.push(result); },
  });
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 's3cret' },
      body: JSON.stringify({ payload: { streamId: 'PRJ1', branchName: 'MDL1' } }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.records, 2);
    assert.equal(got.length, 1);
    assert.equal(got[0].conformant, true);
  } finally {
    srv.close();
  }
});

// 4. Webhook rejects a bad secret.
test('webhook receiver → rejects bad secret', async () => {
  const srv = createWebhookServer({ token: 'pat', secret: 's3cret', port: 0, fetchImpl: fakeFetch });
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' },
      body: JSON.stringify({ payload: { streamId: 'PRJ1' } }),
    });
    assert.equal(res.status, 401);
  } finally {
    srv.close();
  }
});

// 5. Webhook rejects a same-length-but-wrong secret and a missing secret
//    (covers the constant-time comparison's content and length-guard paths).
test('webhook receiver → rejects same-length wrong secret and missing secret', async () => {
  const srv = createWebhookServer({ token: 'pat', secret: 's3cret', port: 0, fetchImpl: fakeFetch });
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  try {
    const sameLen = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'XXXXXX' }, // 6 chars, ≠ s3cret
      body: JSON.stringify({ payload: { streamId: 'PRJ1' } }),
    });
    assert.equal(sameLen.status, 401);

    const missing = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // no secret at all
      body: JSON.stringify({ payload: { streamId: 'PRJ1' } }),
    });
    assert.equal(missing.status, 401);
  } finally {
    srv.close();
  }
});

// ── minimal fake Speckle GraphQL server ───────────────────────────────────────
async function fakeFetch(_url, init) {
  const { query } = JSON.parse(init.body);
  const data = query.includes('versions')
    ? {
        project: {
          id: 'PRJ1', name: 'Sample Project',
          model: {
            id: 'MDL1', name: 'architecture',
            versions: { items: [{ id: 'v123', referencedObject: 'ROOT', createdAt: '2026-06-15T09:00:00Z', message: 'init', authorUser: { name: 'A' } }] },
          },
        },
      }
    : {
        project: {
          id: 'PRJ1', name: 'Sample Project',
          object: {
            id: 'ROOT',
            data: { id: 'ROOT', speckle_type: 'Objects.Organization.Collection', name: 'Commit' },
            children: {
              objects: [
                { id: 'W1', data: { id: 'W1', speckle_type: 'Objects.BuiltElements.Wall', name: 'Wall', category: 'Walls', applicationId: 'd2b8f0a4-1c3e-4b5a-9f6d-0a1b2c3d4e5f-000a1b2c', level: { name: 'L1' } } },
                { id: 'D1', data: { id: 'D1', speckle_type: 'Objects.BuiltElements.Door', name: 'Door', category: 'Doors', GlobalId: '3cUkl32yn9qRSPvBJVuEXk', level: { name: 'L1' } } },
              ],
            },
          },
        },
      };
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data }) };
}

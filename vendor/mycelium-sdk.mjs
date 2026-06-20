// mycelium-sdk — Connective Spine v0.1
// Self-contained: no external runtime deps.
// Node ≥ 18 (uses node:crypto, node:fs).

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const SPINE_VERSION = 'v0.1';

// ── conformance ────────────────────────────────────────────────────────────────

const MUST = ['source', 'sourceLocalId', 'projectKey'];
const JOIN_KEYS = ['ifcGuid', 'uniqueId', 'classification', 'workPackage', 'costCode', 'zone'];

export function checkConformance({ identity = {}, freshness = {} } = {}) {
  const errors = [];
  for (const k of MUST)
    if (identity[k] == null || identity[k] === '') errors.push(`identity.${k} is required (spine MUST-key)`);
  const hasJoin = JOIN_KEYS.some((k) => identity[k] != null && identity[k] !== '');
  if (!hasJoin) errors.push(`identity needs at least one join key (${JOIN_KEYS.join(' | ')})`);
  if (identity.actor && !/^(human|agent|service|did):/.test(String(identity.actor)))
    errors.push('actor must be a pseudonymous ref (human:/agent:/service:/did:)');
  if (freshness && Object.keys(freshness).length) {
    for (const k of ['source', 'revisionId', 'confidence'])
      if (freshness[k] == null || freshness[k] === '') errors.push(`freshness.${k} is required`);
    if (freshness.confidence && !['live', 'snapshot', 'derived'].includes(freshness.confidence))
      errors.push("freshness.confidence must be 'live', 'snapshot', or 'derived'");
  } else {
    errors.push('freshness stamp is required (source, revisionId, confidence)');
  }
  return { conformant: errors.length === 0, spineVersion: SPINE_VERSION, errors };
}

// ── spine-adapter ──────────────────────────────────────────────────────────────

export function template(tpl, record) {
  return String(tpl).replace(/\{([^}]+)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), record);
    return v == null ? '' : String(v);
  });
}

export function stamp({ source, revisionId, asOf, confidence = 'snapshot' } = {}) {
  return {
    source,
    revisionId: revisionId || new Date().toISOString(),
    asOf: asOf || null,
    confidence,
  };
}

export function deterministicExtract(text, rules = []) {
  const edges = {};
  if (!text) return edges;
  for (const rule of rules) {
    const bucket = (edges[rule.edge] ||= []);
    if (rule.regex) {
      const re = new RegExp(rule.regex, 'g');
      for (const m of text.matchAll(re)) bucket.push(m[1] ?? m[0]);
    } else if (Array.isArray(rule.match)) {
      for (const term of rule.match) {
        if (text.includes(term) && !bucket.includes(term)) bucket.push(term);
      }
    }
  }
  for (const k of Object.keys(edges)) {
    edges[k] = [...new Set(edges[k])];
    if (edges[k].length === 0) delete edges[k];
  }
  return edges;
}

export function toSpineRecord(record, config) {
  const { source, identity = {}, freshness: fr = {}, extract = {} } = config;
  const idTpl = identity.uniqueId;
  const uniqueId = idTpl ? template(idTpl, record) : undefined;
  const text = typeof config.text === 'function' ? config.text(record) : record.text;

  const spine = {
    source,
    sourceLocalId: String(record[identity.localIdField || 'id'] ?? uniqueId ?? ''),
    projectKey: identity.projectKey
      ? template(identity.projectKey, record)
      : record.projectKey || record.project,
  };
  if (uniqueId) spine.uniqueId = uniqueId;
  if (record.ifcGuid) spine.ifcGuid = record.ifcGuid;
  if (record.modelInstanceId) spine.modelInstanceId = record.modelInstanceId;
  if (record.classification) spine.classification = record.classification;
  if (record.workPackage) spine.workPackage = record.workPackage;
  if (record.costCode) spine.costCode = record.costCode;
  if (record.zone) spine.zone = record.zone;

  const edges = deterministicExtract(text, extract.deterministic || []);
  if (Object.keys(edges).length) spine.edges = edges;

  const freshness = stamp({
    source,
    revisionId: fr.revisionId ? template(fr.revisionId, record) : undefined,
    asOf: fr.asOf ? template(fr.asOf, record) : record.modified || null,
    confidence: fr.confidence || 'snapshot',
  });

  return { identity: spine, freshness };
}

export async function runAdapter(config, { fetchSource } = {}) {
  if (typeof fetchSource !== 'function')
    throw new Error('runAdapter: pass { fetchSource } returning an array of records');
  const rows = await fetchSource();
  const out = rows.map((r) => toSpineRecord(r, config));
  const results = out.map(({ identity, freshness }) => ({
    identity,
    freshness,
    ...checkConformance({ identity, freshness }),
  }));
  return {
    source: config.source,
    spineVersion: SPINE_VERSION,
    conformant: results.every((r) => r.conformant),
    records: results,
  };
}

// ── provenance ledger ─────────────────────────────────────────────────────────
// Hash uses canonical key order so prevHash is reproducible regardless of
// insertion order. Matches lib/provenance.mjs and orchestrator/src/core/ledger.js.

const RESULTS = new Set(['proposed', 'approved', 'executed', 'rejected', 'failed', 'triaged']);

const CANONICAL_KEY_ORDER = [
  'id', 'prevHash', 'ts', 'projectKey', 'actor', 'proposedBy', 'approvedBy',
  'source', 'action', 'targetKeys', 'revision', 'before', 'after', 'result', 'transport',
];

function canonicalEvent(event) {
  const o = {};
  for (const k of CANONICAL_KEY_ORDER) if (k in event) o[k] = event[k];
  return JSON.stringify(o);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function lastHash(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;
  return sha256(canonicalEvent(JSON.parse(lines.at(-1))));
}

export function append(path, partial) {
  if (!partial.source || !partial.action || !partial.result)
    throw new Error('provenance: source, action, result are required');
  if (!RESULTS.has(partial.result))
    throw new Error(`provenance: invalid result "${partial.result}"`);
  if (partial.actor && !/^(human|agent|service|did):/.test(partial.actor))
    throw new Error('provenance: actor must be a pseudonymous ref (human:/agent:/service:/did:)');
  const event = {
    id: partial.id || randomUUID(),
    prevHash: lastHash(path),
    ts: partial.ts || new Date().toISOString(),
    ...partial,
  };
  appendFileSync(path, JSON.stringify(event) + '\n');
  return event;
}

export function verifyChain(path) {
  if (!existsSync(path)) return { ok: true, count: 0, errors: [] };
  const errors = [];
  let prev = null;
  let count = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    count++;
    const e = JSON.parse(line);
    if (e.prevHash !== prev)
      errors.push({ index: count - 1, id: e.id, expected: prev, actual: e.prevHash });
    prev = sha256(canonicalEvent(e));
  }
  return { ok: errors.length === 0, count, errors };
}

// ── IFC GUID derivation ───────────────────────────────────────────────────────
// Derives an IFC GlobalId from a Revit UniqueId (EpisodeGUID-ElementHex).
// Algorithm matches Autodesk's documented Revit → IFC GUID derivation.

const IFC_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function guidToBytes(guidStr) {
  const hex = guidStr.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToIfcGuid(bytes) {
  const out = [];
  out.push(IFC_ALPHABET[(bytes[0] >> 6) & 0x3]);
  let acc = bytes[0] & 0x3f;
  let bits = 6;
  for (let i = 1; i < 16; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out.push(IFC_ALPHABET[(acc >> bits) & 0x3f]);
    }
  }
  if (bits) out.push(IFC_ALPHABET[(acc << (6 - bits)) & 0x3f]);
  return out.join('');
}

export function deriveIfcGuid(uniqueId) {
  const s = String(uniqueId).trim();
  const m = s.match(/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-([0-9a-fA-F]{8})$/);
  if (!m) throw new Error(`invalid Revit UniqueId: ${uniqueId}`);
  const bytes = guidToBytes(m[1]);
  const elem = BigInt('0x' + m[2]) & 0xffffffffn;
  bytes[12] ^= Number((elem >> 24n) & 0xffn);
  bytes[13] ^= Number((elem >> 16n) & 0xffn);
  bytes[14] ^= Number((elem >> 8n) & 0xffn);
  bytes[15] ^= Number(elem & 0xffn);
  return bytesToIfcGuid(bytes);
}

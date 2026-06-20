// Speckle → Mycelium data client (zero-dep).
//
// Pulls objects from a Speckle server via its GraphQL API and flattens them
// into plain records the spine adapter maps to spine rows. With no token it
// returns an offline mock, so the connector builds, runs and passes
// conformance with zero setup.
//
// EXTEND ME — every step is a pluggable option:
//   mapObject(obj, ctx)       whole Speckle object → spine record fields
//   isElement(obj)            which objects become records
//   extractIfcGuid(obj, fn)   how an IFC GlobalId is resolved
// Defaults handle Revit/IFC-sourced objects. The raw object is always kept on
// record.raw, so you never lose data you haven't mapped yet.

const DEFAULT_SERVER = 'https://app.speckle.systems';
const REVIT_UNIQUEID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{8}$/;

// ── GraphQL ───────────────────────────────────────────────────────────────────
async function gql(server, token, query, variables, fetchImpl) {
  const url = `${String(server).replace(/\/+$/, '')}/graphql`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Speckle GraphQL ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length)
    throw new Error('Speckle GraphQL: ' + json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const Q_LATEST_VERSION = `
  query Latest($projectId: String!, $modelId: String!) {
    project(id: $projectId) {
      id
      name
      model(id: $modelId) {
        id
        name
        versions(limit: 1) {
          items { id referencedObject createdAt message authorUser { name } }
        }
      }
    }
  }`;

const Q_OBJECTS = `
  query Objects($projectId: String!, $objectId: String!, $depth: Int!, $limit: Int!) {
    project(id: $projectId) {
      id
      name
      object(id: $objectId) {
        id
        data
        children(depth: $depth, limit: $limit) {
          objects { id data }
        }
      }
    }
  }`;

// ── default mapping (override via options) ────────────────────────────────────
export function defaultExtractIfcGuid(obj, deriveIfcGuid) {
  const direct =
    obj.GlobalId || obj.globalId || obj.ifcGuid || obj.IFCGuid ||
    obj.properties?.GlobalId || obj.properties?.ifcGuid;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const appId = obj.applicationId || obj.revitUniqueId || obj.elementUniqueId;
  if (typeof appId === 'string' && REVIT_UNIQUEID.test(appId.trim()) && typeof deriveIfcGuid === 'function') {
    try { return deriveIfcGuid(appId.trim()); } catch { /* not derivable */ }
  }
  return undefined;
}

function defaultClassification(obj) {
  const cat = obj.category || obj.builtInCategory || obj.properties?.category;
  const code = obj.type || obj.family || (obj.speckle_type || '').split('.').pop();
  const value = cat || code;
  return value ? [{ system: 'speckle', code: String(value) }] : undefined;
}

function defaultZone(obj) {
  return obj.level?.name || (typeof obj.level === 'string' ? obj.level : undefined) ||
    obj.zone || obj.properties?.level || undefined;
}

function defaultText(obj) {
  return [obj.speckle_type, obj.name, obj.category, obj.family, obj.type].filter(Boolean).join(' ');
}

export function defaultIsElement(obj) {
  if (!obj || !obj.id) return false;
  const t = String(obj.speckle_type || '');
  if (/Collection|DataChunk|Geometry\.|RenderMaterial|^Base$|Objects\.Base$/.test(t)) return false;
  return Boolean(
    obj.name || obj.category || obj.applicationId || obj.GlobalId || obj.ifcGuid ||
    /BuiltElements|Structural|Organization|IFC|Architecture/i.test(t),
  );
}

export function defaultMapObject(obj, ctx) {
  const record = {
    id: obj.id,
    project: ctx.projectKey,
    projectName: ctx.projectName,
    version: ctx.version,
    modified: ctx.modified,
    name: obj.name,
    speckleType: obj.speckle_type,
    text: defaultText(obj),
    raw: obj, // full payload — extend the mapping anytime
  };
  const ifcGuid = (ctx.extractIfcGuid || defaultExtractIfcGuid)(obj, ctx.deriveIfcGuid);
  if (ifcGuid) record.ifcGuid = ifcGuid;
  const classification = defaultClassification(obj);
  if (classification) record.classification = classification;
  const zone = defaultZone(obj);
  if (zone) record.zone = zone;
  return record;
}

// ── main ──────────────────────────────────────────────────────────────────────
export async function fetchSpeckle(options = {}) {
  const {
    server = DEFAULT_SERVER,
    token,
    projectId,
    modelId,
    objectId,
    depth = 50,
    limit = 1000,
    fetchImpl = globalThis.fetch,
    deriveIfcGuid,
    mapObject = defaultMapObject,
    isElement = defaultIsElement,
    extractIfcGuid,
  } = options;

  // Offline / no-credential fallback.
  if (!token || !projectId) {
    const ctx = {
      projectKey: 'demo-project', projectName: 'Demo Project',
      version: 'mock-v1', modified: '2026-06-15T09:00:00Z',
      deriveIfcGuid, extractIfcGuid,
    };
    return mockObjects().filter(isElement).map((o) => mapObject(o, ctx));
  }

  if (typeof fetchImpl !== 'function')
    throw new Error('fetchSpeckle: no fetch available — pass options.fetchImpl');

  // 1. Resolve which object to read: explicit objectId, else the latest version.
  let rootObjectId = objectId;
  let version = objectId ? `object:${objectId}` : null;
  let modified = null;
  let projectName = projectId;

  if (!rootObjectId) {
    if (!modelId) throw new Error('fetchSpeckle: set SPECKLE_MODEL_ID or SPECKLE_OBJECT_ID');
    const d = await gql(server, token, Q_LATEST_VERSION, { projectId, modelId }, fetchImpl);
    const v = d?.project?.model?.versions?.items?.[0];
    if (!v) throw new Error('fetchSpeckle: no versions found for that project/model');
    rootObjectId = v.referencedObject;
    version = v.id;
    modified = v.createdAt;
    projectName = d.project?.name || projectId;
  }

  // 2. Fetch the root object + all detached children.
  const d = await gql(server, token, Q_OBJECTS, { projectId, objectId: rootObjectId, depth, limit }, fetchImpl);
  const root = d?.project?.object;
  if (!root) throw new Error('fetchSpeckle: object not found');
  projectName = d.project?.name || projectName;

  const objects = [];
  if (root.data) objects.push({ id: root.id, ...root.data });
  for (const c of root.children?.objects ?? []) if (c?.data) objects.push({ id: c.id, ...c.data });

  const ctx = { projectKey: projectId, projectName, version, modified, deriveIfcGuid, extractIfcGuid };
  return objects.filter(isElement).map((o) => mapObject(o, ctx));
}

// ── offline mock ────────────────────────────────────────────────────────────────
// Two real identity paths: a Revit wall (applicationId = Revit UniqueId →
// derived IFC GlobalId) and an IFC door (GlobalId carried directly).
export function mockObjects() {
  return [
    {
      id: 'a1b2c3d4e5f600112233445566778899',
      speckle_type: 'Objects.BuiltElements.Wall',
      name: 'Basic Wall:Exterior - Brick on Block',
      category: 'Walls',
      applicationId: 'd2b8f0a4-1c3e-4b5a-9f6d-0a1b2c3d4e5f-000a1b2c',
      level: { name: 'Level 1' },
    },
    {
      id: 'f6e5d4c3b2a100998877665544332211',
      speckle_type: 'Objects.BuiltElements.Door',
      name: 'Single-Flush:0915 x 2134mm',
      category: 'Doors',
      GlobalId: '3cUkl32yn9qRSPvBJVuEXk',
      level: { name: 'Level 1' },
    },
    {
      id: '00000000000000000000000000000000',
      speckle_type: 'Objects.Geometry.Mesh', // geometry container → filtered out
    },
  ];
}

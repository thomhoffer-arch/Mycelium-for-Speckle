# Mycelium-for-Speckle

A [Mycelium](https://github.com/thomhoffer-arch/Mycelium) connector for **[Speckle](https://speckle.systems)**.
It reads objects from a Speckle model — **live**, via Speckle's GraphQL API — and emits
**Connective Spine** records so Speckle data joins with clash, finance, field and other
sources in an orchestrator (Mycelium Studio).

Because Speckle is a **data hub**, this one connector covers every tool a team pushes to
Speckle: Revit, Rhino, Grasshopper, ArchiCAD, Civil3D, IFC, and more. Speckle's
**versions/commits** map directly onto the spine's **freshness + provenance**.

## Install

### Native installer (double-click — nothing else needed)

Download from the [**Releases**](https://github.com/thomhoffer-arch/Mycelium-for-Speckle/releases/latest) page and open it:

| Platform | File | Notes |
|---|---|---|
| **macOS** (Apple Silicon + Intel) | `Mycelium-for-Speckle-<ver>-macos.pkg` | Universal; embeds its own Node runtime |
| **Windows** (x64) | `Mycelium-for-Speckle-<ver>-windows-setup.exe` | Per-user, no admin; embeds its own Node runtime |

These are fully self-contained — the user does **not** need Node.js or anything
else pre-installed. After installing, open a terminal and run `mycelium-for-speckle`.

> The installers are compiled on macOS/Windows runners and published
> automatically by [`.github/workflows/release.yml`](.github/workflows/release.yml)
> when a `v*` tag is pushed.

### One command (installs Node if needed)

**macOS / Linux / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/thomhoffer-arch/Mycelium-for-Speckle/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/thomhoffer-arch/Mycelium-for-Speckle/main/install.ps1 | iex
```

The installer ensures Node.js ≥ 18 (bootstrapping it via `nvm`/`winget` if
missing), fetches the project, puts `mycelium-for-speckle` (and
`mycelium-for-speckle-webhook`) on your PATH, runs the offline conformance suite
to verify, and prints next steps. It's safe to re-run — it updates in place.
There are **no runtime dependencies** (the Mycelium SDK is vendored in `vendor/`).

Prefer to do it by hand? Clone and link:

```bash
git clone https://github.com/thomhoffer-arch/Mycelium-for-Speckle
cd Mycelium-for-Speckle
npm test          # offline conformance suite — no setup needed
npm link          # optional: installs the `mycelium-for-speckle` command
```

## Use it

With no setup at all, run the command to see the offline demo:

```bash
mycelium-for-speckle               # full conformance report → stdout
mycelium-for-speckle --jsonl       # one spine record per line (for piping)
mycelium-for-speckle --help        # all options
```

> Not installed on PATH? Run `node connector.mjs …` from the checkout — identical.

## Run it live

Set the env vars and run:

```bash
export SPECKLE_SERVER="https://app.speckle.systems"   # or your server
export SPECKLE_TOKEN="<personal access token>"        # scope: Streams read
export SPECKLE_PROJECT_ID="<project (stream) id>"
export SPECKLE_MODEL_ID="<model (branch) id>"         # its latest version is read
# optional: read one object instead of a model's latest version
# export SPECKLE_OBJECT_ID="<object id>"

mycelium-for-speckle                 # full conformance report → stdout
mycelium-for-speckle --jsonl         # one spine record per line (for piping)
mycelium-for-speckle --out spine.json
```

Output is one spine record per Speckle element, with identity, freshness
(`confidence: "live"`) and any join edges.

## Push-live (webhook)

Speckle fires a webhook on every new version. Run the receiver and register the URL in
Speckle (project settings → Webhooks):

```bash
SPECKLE_TOKEN=... SPECKLE_SERVER=... SPECKLE_WEBHOOK_SECRET=... mycelium-for-speckle-webhook   # listens on :3000
```

It re-pulls the changed model and emits fresh records on each event — no polling. Pass your
own `onRecords` to `createWebhookServer(...)` to forward records to an orchestrator (Mycelium
Studio), a queue or a file.

## What it maps

| Spine field | From Speckle |
|---|---|
| `uniqueId` | `speckle:{projectId}:{objectId}` |
| `projectKey` | project id |
| `ifcGuid` | `GlobalId`/`ifcGuid` if present, else **derived** from `applicationId` (Revit UniqueId) |
| `classification` | `category` / `family` / `speckle_type` |
| `zone` | `level.name` / `zone` |
| `freshness.revisionId` | Speckle version (commit) id |
| `freshness.asOf` | version `createdAt` |

The **full Speckle object** is kept on `record.raw`, so nothing is lost.

## Extend it

Every mapping step is an override passed to `fetchSpeckle(...)` (see `src/speckle-client.mjs`):

- `mapObject(obj, ctx)` — turn a Speckle object into spine record fields
- `isElement(obj)` — decide which objects become records
- `extractIfcGuid(obj, fn)` — your own identity resolution
- `extract.deterministic` in `connector.mjs` — regex/term edges for fuzzy joins

```js
import { fetchSpeckle } from './src/speckle-client.mjs';

const rows = await fetchSpeckle({
  token, projectId, modelId,
  isElement: (o) => o.speckle_type?.includes('BuiltElements'),
  mapObject: (o, ctx) => ({ id: o.id, project: ctx.projectKey, version: ctx.version,
                            zone: o.room?.name, raw: o }),
});
```

## Conformance

`npm test` runs four checks: the offline mock (builds & conforms with zero setup), a faked
GraphQL round-trip (the live flatten/identity path), and the webhook receiver (re-sync +
secret rejection). All must pass in CI.

## Notes

- Targets the current Speckle (FE2) GraphQL schema: `project → model → versions`,
  `project → object → children`. On an older server, adjust the queries in
  `src/speckle-client.mjs`.
- By default only the root object's **detached children** are walked. To also capture
  deeply-inlined objects, extend `isElement` / `mapObject`.

## License

Apache-2.0 (see `LICENSE`).

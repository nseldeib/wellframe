# Wellframe Coach — MCP server

An [MCP](https://modelcontextprotocol.io) server that gives an AI coach **read-only,
local** access to your Wellframe health data. It reads the same SQLite database the
Wellframe desktop app writes (`wellframe.db` in your OS app-data dir) and exposes the
coach's structured tools — so any MCP host (e.g. Claude Desktop) can reason over your
real history. **Nothing is uploaded**; the server only reads local SQLite.

Storage is read via **sql.js (WASM)**, so the packaged `.mcpb` is a single portable
bundle with no native module to compile per-OS.

## Tools

| Tool | What it returns |
|---|---|
| `get_readiness` | Today's readiness score, label, verdict, coach note |
| `list_workouts` | Recent workouts (limit) |
| `analyze_sleep` | Nightly sleep-quality ratings + sleep trend series |
| `compute_training_load` | Training-load trend + workout counts by type |
| `recommend_recovery` | Recovery score, contributing factors, suggested actions |
| `list_goals` | Goals with progress toward each target |
| `recent_checkins` | Recent check-ins (energy/mood/sleep/soreness/stress + notes) |
| `open_dashboard` | Launches a local, offline **web dashboard** — a browser view of your data (see below) |

## Local web dashboard (`open_dashboard`)

Beyond the read tools, the server can launch a browser view of your Wellframe data —
the same interface as the desktop app, served locally and fully offline. Ask the host
to open it (e.g. *"open my Wellframe dashboard"*) and the `open_dashboard` tool starts
a small web server bound to `127.0.0.1`, opens your browser, and returns the URL.

It serves the desktop frontend's static build and answers `/api/*` from the same
`sql.js` layer the read tools use — one local data source, nothing uploaded. If the
frontend build isn't bundled, the tool still runs the API-only server and reports the
URL. The bundled build is staged into the `.mcpb` by `npm run pack`.

## Develop

```bash
npm install
npm run build
# point it at a database and run over stdio:
WELLFRAME_DB=/path/to/wellframe.db node dist/index.js
```

If `WELLFRAME_DB` is unset it defaults to the desktop app's location for your OS
(e.g. macOS `~/Library/Application Support/com.codeyam.wellframe/wellframe.db`).

## Build a `.mcpb` you can install

```bash
npm install
npm run bundle        # pack → smoke-test → sign
```

That leaves a signed `build/wellframe-coach.mcpb` (~3.3MB). The steps run
individually too:

| Script | What it does |
|---|---|
| `npm run pack` | Compiles, stages a production-only tree, prunes unused sql.js variants, packs |
| `npm run smoke` | Unpacks the bundle and runs all 9 tools against missing / empty / populated databases |
| `npm run sign` | Self-signs with a stable local certificate, then verifies the signature |
| `npm run verify-signature` | Re-checks an existing bundle's signature |
| `npm run validate` | Validates the manifest against the mcpb schema |

`pack` builds from a staged copy rather than the working directory — packing in
place sweeps in TypeScript, the mcpb CLI, and every sql.js build variant (~50MB
unpacked vs ~10MB). It never mutates your dev tree, so there is no
`npm ci --omit=dev` that wipes the dependencies you are still building against.

## Install it in Claude Desktop

1. Run `npm run bundle`.
2. Open `build/` and double-click `wellframe-coach.mcpb` (or drag it into Claude
   Desktop → Settings → Extensions).
3. Claude Desktop will warn that the extension is **not from a verified
   publisher** — see the signing note below. Approve it to continue.
4. Leave the **Wellframe database** setting blank to use the desktop app's own
   database for your OS, or point it at a specific `wellframe.db`.
5. Ask the coach something — "what's my readiness today?", "am I overtraining?"

If the desktop app has never stored anything, the tools return
`No Wellframe database at <path>…` rather than failing silently. Open Wellframe,
log some data, and ask again — the server re-reads the file on every query, so
no restart is needed.

## About signing

`npm run sign` produces a real PKCS#7 signature over the exact bundle bytes,
using a certificate in `.signing/` (gitignored — the private key never leaves
your machine). `npm run verify-signature` confirms it, and fails if a single
byte of the archive changed.

**It will not make Claude Desktop trust the extension**, and
`npx @anthropic-ai/mcpb verify` will still say `Extension is not signed`. Two
separate reasons, neither of them a problem with the bundle:

- A self-signed certificate is not in the OS trust store, so mcpb's chain check
  fails and it reports the bundle as unsigned.
- In mcpb 2.1.2 that check is unreachable anyway: `verifyMcpbFile` calls
  node-forge's `p7.verify()`, which throws *"PKCS#7 signature verification not
  yet implemented"*, and the surrounding `catch` returns `unsigned`. Every
  bundle reads as unsigned, however it was signed.

So treat signing here as tamper-evidence for your own distribution, not as
publisher verification. Real verification needs a CA-issued code-signing
certificate — pass it with `npx @anthropic-ai/mcpb sign --cert … --key …`.

> Avoid `mcpb sign --self-signed`: it ignores `--cert`/`--key` and writes the
> certificate inside `node_modules/@anthropic-ai/mcpb/dist/`, which is wiped on
> every reinstall — so the bundle's signing identity silently changes. That is
> why `scripts/sign.sh` manages its own certificate instead.

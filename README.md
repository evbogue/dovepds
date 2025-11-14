# dovepds — Dove Personal Data Server

This project runs an APDS/anproto‑based personal data server (dovepds) using Deno. It discovers and syncs messages and blobs from APDS peers, serves them to browser clients over WebSockets, and gossips missing items aggressively with per‑peer backoff.

Usage

- Start: `deno run -A main.js <appname> [--port=48080] [--log|-v]`
- Or via task: `deno task start` (defaults to `apds`)
- Permissions: uses `-A` (APIs: timers, env, Web Cache API)

Commands

- Manage pubs:
  - Add: `deno run -A main.js addpub wss://pub.wiredove.net`
  - Remove: `deno run -A main.js rmpub wss://pub.wiredove.net`
- Manage follows:
  - Follow: `deno run -A main.js follow <pubkey> [more...]`
  - Unfollow: `deno run -A main.js unfollow <pubkey> [more...]`
- View log:
  - `deno run -A main.js log [appname]` (pretty JSON of opened log)
- Get by key or author pubkey:
  - `deno run -A main.js <appname> get <hash>`
    - If `<hash>` is a blob key and present, prints blob
    - If `<hash>` is a 44‑char author pubkey and present, prints latest signature

Flags

- `--port=<n>` (default `48080`) — WebSocket server port for browser clients
- `--log` or `-v` — verbose logging (connections, asks/fulfilled, payload info)

WebSocket Server

- Listens on `ws://localhost:<port>` (default 48080)
- Browser client can:
  - Send a key; server responds with the blob if `apds.get(key)` returns data
  - Send a 44‑char author pubkey; server responds with `latest.sig` if known
  - Send a signed message or blob; server ingests it and discovers links
- If a browser requests a 44‑char key we don’t have, it’s enqueued for gossip immediately.

Config

- `dovepub.json` is created on first run with:
  - `pubs`: WebSocket pub peers (seeded with `wss://pub.wiredove.net`)
  - `follows`: author pubkeys to gossip for
- File is reloaded every 10s; pub connections update live; follows merge in.

Gossip Strategy

- Discovery
  - Periodically scans `apds.query()` to find missing hashes:
    - From `opened`: takes `opened.substring(13, 57)` and enqueues if missing
    - Parses YAML message bodies to find `previous`, `reply`, and `replyTo`
      - Enqueues missing `previous`/`reply`
      - Adds `replyTo` authors to `follows`
    - Also scans `image` and `body` for boundary‑aware 44‑char hashlinks
    - Always skips `sig` (signatures are not gossiped)
  - On inbound messages (from pubs or browser), stores blobs, parses YAML, and enqueues discovered links with provenance.
- Asking
  - A 1ms ticker asks peers for items:
    - Prioritizes `gossipMissing` (missing hashes), then followed authors
    - Targets both pub peers and browser clients
    - Tracks per‑hash, per‑peer exponential backoff (up to 5m w/ jitter) to avoid hammering the same server for the same hash
    - Verbose logs include source provenance (opened, yaml.previous, pub.request, ws.request, etc.)
- Pruning
  - Every 10s checks `gossipMissing` against `apds.get()` and removes fulfilled hashes

Protocol

- dovepds speaks APDS on top of anproto (AN). APDS handles hashing/signing/opening of messages using anproto primitives; dovepds orchestrates discovery, gossip, and serving over WebSockets.

Further Reading

- anproto: https://anproto.com

Distribution

- Pub peers and browser clients can request:
  - A blob key → server replies with the blob if present
  - An author pubkey (44 chars) → server replies with the latest signature if known
  - Otherwise, the 44‑char request is queued for gossip

Progress Bar

- Shows in place every 5s (quiet mode):
  - `[##########----------] <have>/<total> missing <n> | db <count>`
  - `have` = opened log entries
  - `missing` = `gossipMissing.size`
  - `db` = have + blobs from pub peers + blobs from browser clients

Notes

- APDS uses the Web Cache API for storage.
- The server maintains persistent WebSocket connections to `pubs` with exponential backoff.
- Verbose mode (`--log`/`-v`) prints detailed gossip activity and payload headers.

---
MIT

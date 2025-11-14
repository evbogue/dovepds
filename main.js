// Deno entrypoint for APDS using CLI args (plain JavaScript)
// Usage: deno run -A main.js <appname>

import { parseArgs } from "jsr:@std/cli/parse-args";
import { apds } from 'https://esm.sh/gh/evbogue/apds@d9326cb/apds.js';
import { startPubManager } from './pubs.js';
import { startWsServer } from './ws_server.js';

const CONFIG_PATH = 'dovepub.json';
const DEFAULT_PUBS = [
  'wss://pub.wiredove.net',
];

async function loadConfig() {
  try {
    const txt = await Deno.readTextFile(CONFIG_PATH);
    const cfg = JSON.parse(txt);
    if (!Array.isArray(cfg.pubs)) cfg.pubs = [];
    if (!Array.isArray(cfg.follows)) cfg.follows = [];
    return cfg;
  } catch (_) {
    const cfg = { pubs: [...DEFAULT_PUBS], follows: [] };
    await Deno.writeTextFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  }
}

async function saveConfig(cfg) {
  await Deno.writeTextFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// Parse CLI args
const args = parseArgs(Deno.args, { boolean: ["log", "v", "help", "h"], string: ["port"] });
const verbose = Boolean(args.log || args.v);
const [cmdOrApp, maybeUrl, ...rest] = args._;

// Help
if (args.help || args.h || cmdOrApp === 'help') {
  console.log(`dovepds — Dove Personal Data Server\n\nUsage:\n  deno run -A main.js <appname> [--port=48080] [--log|-v]\n  deno task start\n\nCommands:\n  addpub <wss-url>        Add a pub peer\n  rmpub <wss-url>         Remove a pub peer\n  follow <pubkey> [...]   Follow one or more authors\n  unfollow <pubkey> [...] Unfollow one or more authors\n  log [appname]           Print opened log as JSON\n  <appname> get <hash>    Print a blob by hash, or latest sig for a pubkey\n  help                    Show this help\n\nFlags:\n  --port=<n>   WebSocket server port (default 48080)\n  --log, -v    Verbose logging\n`);
  Deno.exit(0);
}

// Follow/unfollow commands
if (cmdOrApp === 'follow' || cmdOrApp === 'unfollow') {
  const items = [maybeUrl, ...rest].filter(Boolean).map(String);
  if (items.length === 0) {
    console.log('Usage:');
    console.log('  deno run -A main.js follow <pubkey> [more...]');
    console.log('  deno run -A main.js unfollow <pubkey> [more...]');
    Deno.exit(1);
  }
  const cfg = await loadConfig();
  const isAdd = cmdOrApp === 'follow';
  let changed = false;
  for (const key of items) {
    const idx = cfg.follows.indexOf(key);
    if (isAdd) {
      if (idx === -1) { cfg.follows.push(key); changed = true; console.log(`Followed: ${key}`); }
      else { console.log(`Already following: ${key}`); }
    } else {
      if (idx >= 0) { cfg.follows.splice(idx, 1); changed = true; console.log(`Unfollowed: ${key}`); }
      else { console.log(`Not following: ${key}`); }
    }
  }
  if (changed) await saveConfig(cfg);
  Deno.exit(0);
}

// Log command: print full JSON log from APDS
if (cmdOrApp === 'log') {
  const appName = (maybeUrl && String(maybeUrl)) || 'apds';
  // Pre-start sanitize using Cache API so APDS loads a clean hashlog
  async function preStartSanitize(cacheName) {
    try {
      const base = 'http://localhost:8000/';
      const c = await caches.open(cacheName);
      const resp = await c.match(base + 'hashlog');
      if (!resp) return;
      const raw = await resp.text();
      let arr; try { arr = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(arr) || arr.length === 0) return;
      const keep = [];
      for (const s of arr) {
        try {
          const r = await c.match(base + s);
          if (!r) continue;
          const sig = await r.text();
          const opened = await apds.open(sig);
          if (typeof opened === 'string' && opened.length >= 57) keep.push(s);
        } catch {}
      }
      if (keep.length !== arr.length) {
        await c.put(base + 'hashlog', new Response(JSON.stringify(keep)));
        await c.put(base + 'openedlog', new Response(JSON.stringify([])));
        if (verbose) console.log(`[repair] pruned ${arr.length - keep.length} invalid entries from hashlog (pre-start)`);
      }
    } catch {}
  }
  await preStartSanitize(appName);
  await apds.start(appName);
  const log = await apds.query();
  console.log(JSON.stringify(log ?? [], null, 2));
  Deno.exit(0);
}

// Get command in the form: <appname> get <hash>
if (maybeUrl === 'get') {
  const appName = (cmdOrApp && String(cmdOrApp)) || 'apds';
  const hash = (rest[0] && String(rest[0])) || '';
  if (!hash) {
    console.log('Usage: deno run -A main.js <appname> get <hash>');
    Deno.exit(1);
  }
  // Pre-start sanitize before loading APDS for this app
  // Reuse the preStartSanitize defined above inside 'log' block by redefining here
  async function preStartSanitize(cacheName) {
    try {
      const base = 'http://localhost:8000/';
      const c = await caches.open(cacheName);
      const resp = await c.match(base + 'hashlog');
      if (!resp) return;
      const raw = await resp.text();
      let arr; try { arr = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(arr) || arr.length === 0) return;
      const keep = [];
      for (const s of arr) {
        try {
          const r = await c.match(base + s);
          if (!r) continue;
          const sig = await r.text();
          const opened = await apds.open(sig);
          if (typeof opened === 'string' && opened.length >= 57) keep.push(s);
        } catch {}
      }
      if (keep.length !== arr.length) {
        await c.put(base + 'hashlog', new Response(JSON.stringify(keep)));
        await c.put(base + 'openedlog', new Response(JSON.stringify([])));
      }
    } catch {}
  }
  await preStartSanitize(appName);
  await apds.start(appName);
  try {
    // If this looks like a 44-char pubkey, prefer returning the latest entry
    if (/^[A-Za-z0-9+/]{43}=$/.test(hash)) {
      try {
        const latest = await apds.getLatest(hash);
        if (latest && typeof latest.sig === 'string') {
          console.log(latest.sig);
          Deno.exit(0);
        }
      } catch {}
    }
    const got = await apds.get(hash);
    if (got) { console.log(got); Deno.exit(0); }
    // Fallback: if it is a 44-char pubkey and we didn't find a blob, try latest again
    if (/^[A-Za-z0-9+/]{43}=$/.test(hash)) {
      try {
        const latest = await apds.getLatest(hash);
        if (latest && typeof latest.sig === 'string') { console.log(latest.sig); Deno.exit(0); }
      } catch {}
    }
    console.log('NOT FOUND');
    Deno.exit(2);
  } catch {
    console.log('NOT FOUND');
    Deno.exit(2);
  }
}

if (cmdOrApp === 'addpub' || cmdOrApp === 'rmpub') {
  const url = maybeUrl ? String(maybeUrl) : '';
  if (!url) {
    console.log('Usage:');
    console.log('  deno run -A main.js addpub <wss-url>');
    console.log('  deno run -A main.js rmpub <wss-url>');
    Deno.exit(1);
  }
  const cfg = await loadConfig();
  const idx = cfg.pubs.indexOf(url);
  const isAdd = cmdOrApp === 'addpub';
  if (isAdd) {
    if (idx >= 0) {
      console.log(`Pub already present: ${url}`);
    } else {
      cfg.pubs.push(url);
      await saveConfig(cfg);
      console.log(`Added pub: ${url}`);
    }
  } else {
    if (idx >= 0) {
      cfg.pubs.splice(idx, 1);
      await saveConfig(cfg);
      console.log(`Removed pub: ${url}`);
    } else {
      console.log(`Pub not found: ${url}`);
    }
  }
  Deno.exit(0);
} else {
  const appName = (cmdOrApp && String(cmdOrApp)) || 'apds';
  const cfg = await loadConfig();
  if (verbose) console.log(`Loaded ${cfg.pubs.length} pub(s), ${cfg.follows.length} follow(s) from ${CONFIG_PATH}`);
  await apds.start(appName);
  async function addFollowPersist(key) {
    if (!key || key.length !== 44) return;
    let addedMemory = false;
    if (!gossipKeys.has(key)) { gossipKeys.add(key); addedMemory = true; }
    try {
      const latest = await loadConfig();
      if (!Array.isArray(latest.follows)) latest.follows = [];
      let addedPersist = false;
      if (!latest.follows.includes(key)) {
        latest.follows.push(key);
        await saveConfig(latest);
        addedPersist = true;
      }
      if (addedMemory || addedPersist) console.log(`[follow] added ${key}`);
    } catch (_) {}
  }

  const pubManager = startPubManager(cfg.pubs, {
    onMissingHash: (h, source) => {
      if (typeof h === 'string' && h.length === 44 && !gossipMissing.has(h)) gossipMissing.set(h, source || 'unknown');
    },
    onFollow: (k) => {
      if (typeof k === 'string' && k.length === 44) addFollowPersist(k);
    },
    verbose,
  });
  // Start local WebSocket server for browsers/peers
  const port = args.port ? Number(args.port) : (Deno.env.get('PORT') ? Number(Deno.env.get('PORT')) : 48080);
  const wsManager = startWsServer(apds, {
    port,
    verbose,
    onMissingHash: (h, src) => {
      if (typeof h === 'string' && h.length === 44 && !gossipMissing.has(h)) gossipMissing.set(h, src || 'ws.incoming');
    },
    onFollow: (k) => {
      if (typeof k === 'string' && k.length === 44) addFollowPersist(k);
    },
  });
  // Seed gossip queues
  const gossipKeys = new Set((cfg.follows || []).map(String)); // permanent pubkeys
  const gossipMissing = new Map(); // hash -> source; missing hashes from opened field only
  let lastHaveCount = 0; // updated during log scan

  // Periodically print log and queue missing opened hashes and YAML links
  setInterval(async () => {
    try {
      const entries = await apds.query();
      if (verbose) console.log(JSON.stringify(entries ?? [], null, 2));
      lastHaveCount = Array.isArray(entries) ? entries.length : 0;
      if (!Array.isArray(entries)) return;
      for (const e of entries) {
        if (e && typeof e.opened === 'string' && e.opened.length >= 57) {
          const h = e.opened.substring(13, 57);
          if (h && h.length === 44 && !gossipMissing.has(h)) {
            const have = await apds.get(h);
            if (!have) gossipMissing.set(h, 'opened');
          }
        }
        // If the entry has text that looks like YAML, parse and inspect fields
        if (e && typeof e.text === 'string' && e.text.length) {
          try {
            const yaml = await apds.parseYaml(e.text);
            if (yaml && typeof yaml === 'object') {
              const addIfMissing = async (h) => {
                if (typeof h === 'string' && h.length === 44 && !gossipMissing.has(h)) {
                  const have = await apds.get(h);
                  if (!have) gossipMissing.set(h, 'yaml.scan');
                }
              };
              await addIfMissing(yaml.previous);
              await addIfMissing(yaml.reply);
              if (typeof yaml.replyTo === 'string' && yaml.replyTo.length === 44) {
                addFollowPersist(yaml.replyTo);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {
      // ignore errors during crawl
    }
  }, 15_000);

  // Periodic progress bar (overwrite in place)
  const enc = new TextEncoder();
  let lastLineLen = 0;
  setInterval(() => {
    const missing = gossipMissing.size;
    const have = lastHaveCount;
    const total = have + missing;
    const width = 40;
    const ratio = total > 0 ? have / total : 1;
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
    const blobCountPub = typeof pubManager.getBlobCount === 'function' ? pubManager.getBlobCount() : 0;
    const blobCountWs = (wsManager && wsManager.getBlobCount) ? wsManager.getBlobCount() : 0;
    const dbTotal = have + blobCountPub + blobCountWs;
    const line = `${bar} ${have}/${total} missing ${missing} | db ${dbTotal}`;
    const pad = lastLineLen > line.length ? ' '.repeat(lastLineLen - line.length) : '';
    lastLineLen = line.length;
    Deno.stdout.write(enc.encode(`\r${line}${pad}`)).catch(() => {});
  }, 5_000);

  // Start periodic gossip: ask for missing hashes first, otherwise pubkeys
  const backoff = new Map(); // hash -> (peerId -> { attempt, nextAt })
  setInterval(() => {
    const urls = pubManager.getConnectedUrls();
    const clients = (wsManager && wsManager.getClientIds) ? wsManager.getClientIds() : [];
    if (!urls.length && clients.length === 0) return;
    let askedMsg = null;
    const now = Date.now();

    if (gossipMissing.size > 0) {
      const hashes = Array.from(gossipMissing.keys());
      // Try a few random candidates to find an eligible url based on backoff
      for (let tries = 0; tries < 8; tries++) {
        const want = hashes[Math.floor(Math.random() * hashes.length)];
        const src = gossipMissing.get(want) || 'unknown';
        let per = backoff.get(want);
        if (!per) { per = new Map(); backoff.set(want, per); }

        // Randomize peer order over pubs + ws clients
        const peers = urls.map(u => ({ kind: 'pub', id: u }))
          .concat(clients.map(c => ({ kind: 'ws', id: c })));
        const shuffled = peers.slice().sort(() => Math.random() - 0.5);
        for (const p of shuffled) {
          const peerKey = `${p.kind}:${p.id}`;
          const rec = per.get(peerKey) || { attempt: 0, nextAt: 0 };
          if (rec.nextAt <= now) {
            const ok = p.kind === 'pub'
              ? pubManager.sendToUrl(p.id, want)
              : (wsManager && wsManager.sendToClient ? wsManager.sendToClient(p.id, want) : false);
            if (ok) {
              const attempt = Math.min(rec.attempt + 1, 32);
              const base = 1000; // 1s
              const max = 5 * 60 * 1000; // 5m
              const delay = Math.min(base * (2 ** (attempt - 1)), max);
              const jitter = Math.floor(delay * (0.2 * Math.random()));
              rec.attempt = attempt;
              rec.nextAt = now + delay + jitter;
              per.set(peerKey, rec);
              if (verbose) askedMsg = `[missing ${src}] ${want} -> ${peerKey}`;
              break;
            }
          }
        }
        if (askedMsg) break; // sent one this tick
      }
    } else if (gossipKeys.size > 0) {
      const keys = Array.from(gossipKeys);
      const key = keys[Math.floor(Math.random() * keys.length)];
      // Try a pub or a ws client
      let sent = false;
      if (urls.length && Math.random() < 0.5) {
        const url = pubManager.sendToRandomConnected(key);
        if (url) { sent = true; if (verbose) askedMsg = `[follow] ${key} -> pub:${url}`; }
      }
      if (!sent && clients.length && wsManager && wsManager.sendToRandomClient) {
        const id = wsManager.sendToRandomClient(key);
        if (id) { if (verbose) askedMsg = `[follow] ${key} -> ws:${id}`; }
      }
    }
    if (askedMsg && verbose) console.log(`\n[gossip] asked ${askedMsg}`);
  }, 1);

  // Periodically prune gossipMissing by checking availability
  setInterval(async () => {
    if (gossipMissing.size === 0) return;
    const snapshot = Array.from(gossipMissing.keys());
    for (const h of snapshot) {
      try {
        const have = await apds.get(h);
        if (have) {
          const src = gossipMissing.get(h) || 'unknown';
          gossipMissing.delete(h);
          backoff.delete(h);
          if (verbose) console.log(`\n[gossip] fulfilled ${h} (from ${src})`);
        }
      } catch (_) {
        // ignore
      }
    }
  }, 10_000);
  // Periodically reload config to pick up changes
  let lastCfgText = JSON.stringify(cfg);
  let lastPubsKey = JSON.stringify([...(cfg.pubs || []).map(String)].sort());
  let lastFollowsKey = JSON.stringify([...(cfg.follows || []).map(String)].sort());
  setInterval(async () => {
    try {
      const txt = await Deno.readTextFile(CONFIG_PATH);
      if (txt !== lastCfgText) {
        lastCfgText = txt;
        const next = JSON.parse(txt);
        if (Array.isArray(next.pubs)) {
          const nextPubsKey = JSON.stringify([...(next.pubs || []).map(String)].sort());
          if (nextPubsKey !== lastPubsKey) {
            lastPubsKey = nextPubsKey;
            pubManager.update(next.pubs);
            if (verbose) console.log(`[config] pubs updated (${next.pubs.length})`);
          }
        }
        if (Array.isArray(next.follows)) {
          const nextFollowsKey = JSON.stringify([...(next.follows || []).map(String)].sort());
          if (nextFollowsKey !== lastFollowsKey) {
            lastFollowsKey = nextFollowsKey;
            let added = 0;
            for (const k of next.follows) {
              const s = String(k);
              if (!gossipKeys.has(s)) { gossipKeys.add(s); added++; }
            }
            if (added && verbose) console.log(`[config] follows added (${added})`);
          }
        }
      }
    } catch (_) {
      // ignore
    }
  }, 10_000);
  if (verbose) console.log(`APDS started with cache "${appName}"`);
}

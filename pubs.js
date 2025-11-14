// Manage WebSocket connections to pubs with exponential backoff
import { apds } from 'https://esm.sh/gh/evbogue/apds@d9326cb/apds.js';

export function startPubManager(initialPubs = [], opts = {}) {
  const states = new Map(); // url -> {attempt, ws, removed}
  const onMissingHash = typeof opts.onMissingHash === 'function' ? opts.onMissingHash : null;
  const onFollow = typeof opts.onFollow === 'function' ? opts.onFollow : null;
  const verbose = Boolean(opts.verbose);
  const storedBlobs = new Set(); // unique blob hashes we've stored via apds.make
  const isOpenedString = (s) => typeof s === 'string' && s.length === 57 && /^(\d{13})([A-Za-z0-9+/]{43}=)$/.test(s);

  function connectWithBackoffLocal(url, state) {
    try {
      const ws = new WebSocket(url);
      let opened = false;
      state.ws = ws;

      ws.onopen = () => {
        opened = true;
        state.attempt = 0;
        if (verbose) console.log(`[pub] Connected: ${url}`);
      };

      ws.onmessage = (ev) => {
        const d = ev.data;
        const handleText = async (t) => {
          if (typeof t === 'string') {
            if (verbose) console.log(`[pub] recv ${url}: ${t}`);
            // If peer requests a specific hash, reply with the blob if we have it
            try {
              // Always try to serve a direct get for what the peer asked
              const got = await apds.get(t);
              if (got) {
                try {
                  ws.send(got);
                  if (verbose) {
                    console.log(`[pub] send blob for ${t} -> ${url}`);
                    console.log(`[pub] payload (${got.length} chars)`);
                  }
                } catch {}
                return;
              }
            } catch {}
            // If a 44-char request we don't have, enqueue for gossip
            try {
              if (typeof t === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(t)) {
                try { onMissingHash && onMissingHash(t, 'pub.request'); } catch {}
              }
            } catch {}
            // If it looks like a 44-char pubkey/hash, try latest by author
            try {
              if (typeof t === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(t)) {
                const latest = await apds.getLatest(t);
                if (latest && typeof latest.sig === 'string') {
                  try {
                    ws.send(latest.sig);
                    if (verbose) console.log(`[pub] send latest sig for author ${t} -> ${url}`);
                  } catch {}
                  return;
                }
              }
            } catch {}
            try {
              // Only add if it opens as a valid signature (13-digit ts + 44-char hash)
              let canAdd = false;
              try { const opened = await apds.open(t); canAdd = isOpenedString(opened); } catch {}
              if (canAdd) {
                const stored = await apds.add(t);
                if (stored && verbose) console.log(`[apds] stored from ${url}: ${t}`);
              }
              try {
                const blobHash = await apds.make(t);
                if (blobHash) storedBlobs.add(blobHash);
                const yaml = await apds.parseYaml(t);
                if (yaml && typeof yaml === 'object') {
                  const sigVal = (typeof yaml.sig === 'string') ? yaml.sig : null;
                  const addMissing = async (h, source) => {
                    if (typeof h === 'string' && h.length === 44 && h !== sigVal) {
                      try {
                        const have = await apds.get(h);
                        if (!have) onMissingHash && onMissingHash(h, source);
                      } catch {}
                    }
                  };
                  // direct fields
                  await addMissing(yaml.previous, 'yaml.previous');
                  await addMissing(yaml.reply, 'yaml.reply');
                  if (typeof yaml.replyTo === 'string' && yaml.replyTo.length === 44) {
                    try { onFollow && onFollow(yaml.replyTo); } catch {}
                  }
                  // inline links in image/body
                  const scanInline = async (val, source) => {
                    if (typeof val === 'string') {
                      const re = /(^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{43}=)(?![A-Za-z0-9+/])/g;
                      let match;
                      while ((match = re.exec(val)) !== null) {
                        const h = match[2];
                        if (h && h !== sigVal) await addMissing(h, source);
                      }
                    }
                  };
                  await scanInline(yaml.image, 'yaml.image');
                  await scanInline(yaml.body, 'yaml.body');
                }
              } catch {}
            } catch (_) {
              // ignore parse/store errors
            }
          }
        };
        if (typeof d === 'string') {
          handleText(d);
        } else if (d instanceof ArrayBuffer) {
          const t = new TextDecoder().decode(new Uint8Array(d));
          handleText(t);
        } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
          d.text().then(handleText).catch(() => {});
        } else {
          // Unsupported type; ignore
        }
      };

      const scheduleReconnect = (why) => {
        if (state.removed) return; // do not reconnect removed pubs
        const base = 1000; // 1s
        const max = 5 * 60 * 1000; // 5m
        const attempt = Math.min(state.attempt + 1, 32);
        state.attempt = attempt;
        const delay = Math.min(base * (2 ** (attempt - 1)), max);
        const jitter = Math.floor(delay * (0.2 * Math.random()));
        const wait = delay + jitter;
        const note = opened ? 'closed' : 'error';
        if (verbose) console.log(`[pub] ${note} (${why}). Reconnecting in ${Math.round(wait/1000)}s: ${url}`);
        setTimeout(() => connectWithBackoffLocal(url, state), wait);
      };

      ws.onerror = () => {
        scheduleReconnect('onerror');
      };

      ws.onclose = () => {
        scheduleReconnect('onclose');
      };
    } catch (_) {
      const base = 1000;
      const max = 5 * 60 * 1000;
      const attempt = Math.min(state.attempt + 1, 32);
      state.attempt = attempt;
      const delay = Math.min(base * (2 ** (attempt - 1)), max);
      const jitter = Math.floor(delay * (0.2 * Math.random()));
      const wait = delay + jitter;
      if (verbose) console.log(`[pub] connect exception. Reconnecting in ${Math.round(wait/1000)}s: ${url}`);
      setTimeout(() => connectWithBackoffLocal(url, state), wait);
    }
  }

  function ensure(url) {
    if (typeof url !== 'string' || !url.startsWith('ws')) return;
    let st = states.get(url);
    if (!st) {
      st = { attempt: 0, ws: undefined, removed: false };
      states.set(url, st);
      connectWithBackoffLocal(url, st);
    } else if (!st.ws || st.ws.readyState >= 2) {
      st.removed = false;
      connectWithBackoffLocal(url, st);
    }
  }

  function remove(url) {
    const st = states.get(url);
    if (!st) return;
    st.removed = true;
    if (st.ws && (st.ws.readyState === 0 || st.ws.readyState === 1)) {
      try { st.ws.close(1000, 'removed'); } catch {}
    }
  }

  function update(newPubs = []) {
    const next = new Set(newPubs);
    // Add or ensure
    for (const url of next) ensure(String(url));
    // Remove missing
    for (const url of Array.from(states.keys())) {
      if (!next.has(url)) remove(url);
    }
  }

  function stop() {
    for (const url of Array.from(states.keys())) remove(url);
  }

  // prime
  update(initialPubs);

  function getConnectedUrls() {
    const urls = [];
    for (const [url, st] of states) {
      if (st.ws && st.ws.readyState === 1 && !st.removed) urls.push(url);
    }
    return urls;
  }

  function sendToRandomConnected(message) {
    const urls = getConnectedUrls();
    if (!urls.length) return null;
    const url = urls[Math.floor(Math.random() * urls.length)];
    const st = states.get(url);
    try {
      st.ws.send(message);
      return url;
    } catch (_) {
      return null;
    }
  }

  function sendToUrl(url, message) {
    const st = states.get(url);
    if (!st || !st.ws || st.ws.readyState !== 1 || st.removed) return false;
    try {
      st.ws.send(message);
      return true;
    } catch (_) {
      return false;
    }
  }

  function getBlobCount() { return storedBlobs.size; }

  return { update, stop, getConnectedUrls, sendToRandomConnected, sendToUrl, getBlobCount };
}

function connectWithBackoff_UNUSED(url, state) {
  try {
    const ws = new WebSocket(url);
    let opened = false;
    state.ws = ws;

    ws.onopen = () => {
      opened = true;
      state.attempt = 0;
      if (verbose) console.log(`[pub] Connected: ${url}`);
    };

    ws.onmessage = (ev) => {
      const d = ev.data;
      const handleText = async (t) => {
        if (typeof t === 'string') {
          if (verbose) console.log(`[pub] recv ${url}: ${t}`);
          try {
            const stored = await apds.add(t);
            if (stored) {
              if (verbose) console.log(`[apds] stored from ${url}: ${t}`);
            }
            // Also treat as a blob: store and parse for linked hashes
            try {
              const blobHash = await apds.make(t);
              const yaml = await apds.parseYaml(t);
              if (yaml && typeof yaml === 'object') {
                const toCheck = [];
                const addIf44 = (val) => { if (typeof val === 'string' && val.length === 44) toCheck.push(val); };
                addIf44(yaml.previous);
                addIf44(yaml.reply);
                if (typeof yaml.replyTo === 'string' && yaml.replyTo.length === 44) {
                  try { onFollow && onFollow(yaml.replyTo); } catch {}
                }
                // still look for inline links in body and image references
                const pushInline = (val) => {
                  if (typeof val === 'string') {
                    const m = val.match(/[A-Za-z0-9+/]{44}/g);
                    if (m) m.forEach((h) => toCheck.push(h));
                  }
                };
                pushInline(yaml.image);
                pushInline(yaml.body);

                for (const h of toCheck) {
                  try {
                    const have = await apds.get(h);
                    if (!have) onMissingHash && onMissingHash(h);
                  } catch {}
                }
              }
            } catch {}
          } catch (_) {
            // ignore parse/store errors
          }
        }
      };
      if (typeof d === 'string') {
        handleText(d);
      } else if (d instanceof ArrayBuffer) {
        const t = new TextDecoder().decode(new Uint8Array(d));
        handleText(t);
      } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.text().then(handleText).catch(() => {});
      } else {
        // Unsupported type; ignore
      }
    };

    const scheduleReconnect = (why) => {
      if (state.removed) return; // do not reconnect removed pubs
      // Exponential backoff with cap and jitter
      const base = 1000; // 1s
      const max = 5 * 60 * 1000; // 5m
      const attempt = Math.min(state.attempt + 1, 32);
      state.attempt = attempt;
      const delay = Math.min(base * (2 ** (attempt - 1)), max);
      const jitter = Math.floor(delay * (0.2 * Math.random()));
      const wait = delay + jitter;
      const note = opened ? 'closed' : 'error';
      if (verbose) console.log(`[pub] ${note} (${why}). Reconnecting in ${Math.round(wait/1000)}s: ${url}`);
      setTimeout(() => connectWithBackoff(url, state), wait);
    };

    ws.onerror = () => {
      scheduleReconnect('onerror');
    };

    ws.onclose = () => {
      scheduleReconnect('onclose');
    };
  } catch (_) {
    // Immediate failure: schedule next attempt
    const base = 1000;
    const max = 5 * 60 * 1000;
    const attempt = Math.min(state.attempt + 1, 32);
    state.attempt = attempt;
    const delay = Math.min(base * (2 ** (attempt - 1)), max);
    const jitter = Math.floor(delay * (0.2 * Math.random()));
    const wait = delay + jitter;
    if (verbose) console.log(`[pub] connect exception. Reconnecting in ${Math.round(wait/1000)}s: ${url}`);
    setTimeout(() => connectWithBackoff(url, state), wait);
  }
}

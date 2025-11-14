export function startWsServer(apds, { port = 48080, verbose = false, onMissingHash = null, onFollow = null } = {}) {
  const clients = new Map(); // id -> WebSocket
  let seq = 0;
  const storedBlobs = new Set();

  try {
    Deno.serve({ port }, (req) => {
      const upgrade = req.headers.get('upgrade') || '';
      if (upgrade.toLowerCase() !== 'websocket') {
        return new Response('WebSocket endpoint', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const id = `client-${++seq}`;
      socket.onopen = () => { clients.set(id, socket); if (verbose) console.log(`[ws] client connected ${id}`) };
      socket.onmessage = async (ev) => {
        try {
          const data = ev.data;
          const handleText = async (raw) => {
            const t = String(raw).trim();
            // Try to serve a direct get for what the client asked
            try {
              const got = await apds.get(t);
              if (got) {
                try {
                  socket.send(got);
                  if (verbose) {
                    console.log(`[ws] send blob for ${t}`);
                    console.log(`[ws] payload (${got.length} chars)`);
                  }
                } catch {}
                return;
              }
            } catch {}
            // If it looks like a 44-char pubkey/hash, enqueue missing and try latest by author
            try {
              if (/^[A-Za-z0-9+/]{43}=$/.test(t)) {
                try { onMissingHash && onMissingHash(t, 'ws.request'); } catch {}
                const latest = await apds.getLatest(t);
                if (latest && typeof latest.sig === 'string') {
                  try {
                    socket.send(latest.sig);
                    if (verbose) console.log(`[ws] send latest sig for author ${t}`);
                  } catch {}
                  return;
                }
              }
            } catch {}
            // Ingest signed messages and blobs; discover links similar to pub peers
            try {
              let canAdd = false;
              try { const opened = await apds.open(t); canAdd = typeof opened === 'string' && opened.length >= 57; } catch {}
              if (canAdd) {
                const stored = await apds.add(t);
                if (stored && verbose) console.log(`[ws] stored from ${id}: ${t}`);
              }
              try {
                const blobHash = await apds.make(t);
                if (blobHash) storedBlobs.add(blobHash);
                const yaml = await apds.parseYaml(t);
                if (yaml && typeof yaml === 'object') {
                  const sigVal = (typeof yaml.sig === 'string') ? yaml.sig : null;
                  const addMissing = async (h, source) => {
                    if (typeof h === 'string' && h.length === 44 && h !== sigVal) {
                      try { const have = await apds.get(h); if (!have && onMissingHash) onMissingHash(h, source); } catch {}
                    }
                  };
                  await addMissing(yaml.previous, 'yaml.previous');
                  await addMissing(yaml.reply, 'yaml.reply');
                  if (typeof yaml.replyTo === 'string' && yaml.replyTo.length === 44) { try { onFollow && onFollow(yaml.replyTo); } catch {} }
                  const scanInline = async (val, source) => {
                    if (typeof val === 'string') {
                      const re = /(^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{43}=)(?![A-Za-z0-9+/])/g;
                      let match; while ((match = re.exec(val)) !== null) { const h = match[2]; if (h && h !== sigVal) await addMissing(h, source); }
                    }
                  };
                  await scanInline(yaml.image, 'yaml.image');
                  await scanInline(yaml.body, 'yaml.body');
                }
              } catch {}
            } catch {}
          };

          if (typeof data === 'string') {
            await handleText(data);
          } else if (data instanceof ArrayBuffer) {
            const t = new TextDecoder().decode(new Uint8Array(data));
            await handleText(t);
          } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
            try {
              const t = await data.text();
              await handleText(t);
            } catch {}
          }
        } catch {}
      };
      socket.onclose = () => { clients.delete(id); if (verbose) console.log(`[ws] client disconnected ${id}`) };
      socket.onerror = () => {};
      return response;
    });
    if (verbose) console.log(`[ws] listening on :${port}`);
  } catch (e) {
    if (verbose) console.log(`[ws] failed to listen: ${e?.message || e}`);
  }

  function getClientIds() { return Array.from(clients.keys()); }
  function sendToClient(id, message) {
    const ws = clients.get(id);
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(message); return true; } catch { return false; }
  }
  function sendToRandomClient(message) {
    const ids = getClientIds();
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    return sendToClient(id, message) ? id : null;
  }
  function getBlobCount() { return storedBlobs.size; }

  return { getClientIds, sendToClient, sendToRandomClient, getBlobCount };
}

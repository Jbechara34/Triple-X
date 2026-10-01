'use strict';

// Tails the last N lines of a log file without reading the whole thing into
// memory for large files - used by the Logs tab (monerod + p2pool). Also
// provides a live tail (Server-Sent Events) so the Logs tab updates the
// moment a new line is written, like `tail -f` in a terminal.

const fsp = require('fs/promises');
const path = require('path');

const MAX_READ_BYTES = 128 * 1024; // plenty for a few hundred lines
const MAX_LINES = 300;
const POLL_MS = 1000;

// Most of our processes write to one fixed, known log path (monerod,
// p2pool). Some don't - e.g. minotari_node's logging is configured via a
// log4rs.yml whose exact output filename/subdirectory layout has changed
// between versions (see docker-compose.yml's MINOTARI_LOG_FILE comment) and
// isn't reliably pinned down here. For those, fall back to the newest *.log
// file found by walking the mounted log volume - both the exact configured
// directory, and (if that comes up empty) a couple of levels up from it, in
// case log4rs's output subdirectory moved or was never there to begin with.
const MAX_SCAN_DEPTH = 3;

async function newestLogFileUnder(dir, depth) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.log')) {
      candidates.push(p);
    } else if (e.isDirectory() && depth < MAX_SCAN_DEPTH) {
      const nested = await newestLogFileUnder(p, depth + 1);
      if (nested) candidates.push(nested);
    }
  }
  if (!candidates.length) return null;
  const withStats = await Promise.all(
    candidates.map(async (p) => ({ p, mtime: (await fsp.stat(p)).mtimeMs }))
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0].p;
}

async function resolveLogPath(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isFile()) return filePath;
  } catch (err) {
    // not found at the exact path - fall through to the directory scan below
  }
  // Try the configured directory first (cheap, common case), then walk up
  // to 2 levels toward the mounted volume's root in case the log4rs output
  // layout doesn't match what MINOTARI_LOG_FILE assumes.
  let dir = path.dirname(filePath);
  for (let up = 0; up < 3; up += 1) {
    const found = await newestLogFileUnder(dir, 0);
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return filePath;
}

async function tailFile(filePath, maxLines = MAX_LINES) {
  let fh;
  try {
    const resolved = await resolveLogPath(filePath);
    fh = await fsp.open(resolved, 'r');
    const stat = await fh.stat();
    const readSize = Math.min(stat.size, MAX_READ_BYTES);
    const start = stat.size - readSize;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, start);
    const lines = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    return { lines: lines.slice(-maxLines), error: null };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { lines: [], error: 'Log file not created yet - waiting for the process to start.' };
    }
    return { lines: [], error: err.message };
  } finally {
    if (fh) await fh.close();
  }
}

// Streams new lines appended to `filePath` to `res` as Server-Sent Events,
// starting with the current tail so the client has something to show right
// away. Polls for new bytes (like app/lib/blocks.js does) rather than using
// fs.watch, since watch behaves inconsistently across the bind-mounted /
// named-volume filesystems this runs on (Docker volumes, NFS, etc).
function attachTailStream(res, filePath) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  let stopped = false;
  let offset = 0;
  let timer = null;
  let heartbeatTimer = null;
  let resolvedPath = filePath;

  function send(event, data) {
    if (stopped) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function poll() {
    if (stopped) return;
    try {
      // Re-resolve each tick: cheap (one small directory listing) and lets
      // us pick up a log file that didn't exist yet when we first attached.
      resolvedPath = await resolveLogPath(filePath);
      const stat = await fsp.stat(resolvedPath);
      if (stat.size < offset) offset = 0; // rotated/truncated
      if (stat.size > offset) {
        const fh = await fsp.open(resolvedPath, 'r');
        try {
          const toRead = stat.size - offset;
          const buf = Buffer.alloc(toRead);
          await fh.read(buf, 0, toRead, offset);
          offset = stat.size;
          const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
          if (lines.length) send('append', lines);
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      // File not created yet, or transient read error - just try again next tick.
    }
  }

  (async () => {
    const initial = await tailFile(filePath);
    if (stopped) return;
    send('init', initial);
    try {
      resolvedPath = await resolveLogPath(filePath);
      const stat = await fsp.stat(resolvedPath);
      offset = stat.size;
    } catch (err) {
      offset = 0;
    }
    timer = setInterval(poll, POLL_MS);
    // Reverse proxies in front of this app (confirmed: 5tratumOS routes
    // through one at /apps/<id>/ even though docker-compose.yml's own
    // comments assumed there wasn't one) tend to kill a chunked response
    // that's gone quiet for a while, surfacing client-side as
    // net::ERR_INCOMPLETE_CHUNKED_ENCODING - a real new log line can be
    // minutes apart on an idle node, so a silent SSE connection isn't rare.
    // A periodic comment line keeps bytes flowing without affecting the
    // actual event stream (SSE comments start with ":" and are ignored by
    // EventSource).
    heartbeatTimer = setInterval(() => {
      if (stopped) return;
      res.write(':heartbeat\n\n');
    }, 15000);
  })();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };
}

module.exports = { tailFile, attachTailStream };

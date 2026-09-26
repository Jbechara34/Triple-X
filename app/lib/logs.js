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
// log4rs.yml whose exact output filename isn't pinned down here yet. For
// those, fall back to the newest *.log file in the same directory instead
// of guessing a filename outright.
async function resolveLogPath(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isFile()) return filePath;
  } catch (err) {
    // not found at the exact path - fall through to the directory scan below
  }
  const dir = path.dirname(filePath);
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const logFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.log'));
    if (!logFiles.length) return filePath;
    const withStats = await Promise.all(
      logFiles.map(async (e) => {
        const p = path.join(dir, e.name);
        const s = await fsp.stat(p);
        return { p, mtime: s.mtimeMs };
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0].p;
  } catch (err) {
    return filePath;
  }
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
  })();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

module.exports = { tailFile, attachTailStream };

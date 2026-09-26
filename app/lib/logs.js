'use strict';

// Tails the last N lines of a log file without reading the whole thing into
// memory for large files - used by the Logs tab (monerod + p2pool). Also
// provides a live tail (Server-Sent Events) so the Logs tab updates the
// moment a new line is written, like `tail -f` in a terminal.

const fsp = require('fs/promises');

const MAX_READ_BYTES = 128 * 1024; // plenty for a few hundred lines
const MAX_LINES = 300;
const POLL_MS = 1000;

async function tailFile(filePath, maxLines = MAX_LINES) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
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

  function send(event, data) {
    if (stopped) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function poll() {
    if (stopped) return;
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size < offset) offset = 0; // rotated/truncated
      if (stat.size > offset) {
        const fh = await fsp.open(filePath, 'r');
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
      const stat = await fsp.stat(filePath);
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

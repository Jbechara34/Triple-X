'use strict';

// Tails the last N lines of a log file without reading the whole thing into
// memory for large files - used by the Logs tab (monerod + p2pool).

const fsp = require('fs/promises');

const MAX_READ_BYTES = 128 * 1024; // plenty for a few hundred lines
const MAX_LINES = 300;

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

module.exports = { tailFile };

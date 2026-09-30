'use strict';

/**
 * Sends a command into p2pool's own stdin console (status, workers, peers,
 * ...) - see docker/p2pool/entrypoint.sh, which pipes p2pool's stdin from a
 * named FIFO in the shared-config volume this container also mounts
 * read-write. p2pool prints the response to its own stdout, which is
 * already tailed into p2pool.log (and so shows up in the Logs tab like any
 * other p2pool output) - this module only handles the write side.
 */

const fs = require('fs');

const COMMAND_FIFO = process.env.COMMAND_FIFO || '/data/config/p2pool-command';

// Only commands p2pool actually recognizes (src/console_commands.cpp) that
// are safe to expose from the UI - read-only/informational. Deliberately
// excludes anything that changes p2pool's behavior (exit, droppeers,
// stop_mining, inpeers/outpeers, ...).
const ALLOWED_COMMANDS = new Set(['status', 'workers', 'peers', 'version', 'help']);

function sendCommand(command) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_COMMANDS.has(command)) {
      reject(Object.assign(new Error(`Unsupported command: ${command}`), { statusCode: 400 }));
      return;
    }
    // O_WRONLY would throw ENXIO if nothing has the read end open yet; the
    // entrypoint script holds fd 9 open read-write for the container's
    // entire lifetime specifically so this always has a peer.
    fs.open(COMMAND_FIFO, 'w', (err, fd) => {
      if (err) {
        reject(Object.assign(new Error('p2pool command pipe not reachable - is the p2pool container running?'), { statusCode: 503 }));
        return;
      }
      fs.write(fd, `${command}\n`, (writeErr) => {
        fs.close(fd, () => {
          if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    });
  });
}

module.exports = { sendCommand, ALLOWED_COMMANDS };

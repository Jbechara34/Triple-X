'use strict';

// Settings tab's Import Blockchain "Browse..." button - lets the user click
// through the OTHER machine's real folders instead of typing a path blind.
// Uses ssh2's own SFTP client (not the system ssh/sftp binaries) since SFTP
// is a single protocol that works the same way regardless of whether the
// remote machine is Windows, Linux, or Mac - no shell/OS-specific command
// parsing (e.g. `ls` vs `dir`) to get wrong.
//
// Same credential-handling rules as blockchainImport.js: nothing here is
// logged, persisted, or echoed back beyond the single request it's used for.

const { Client } = require('ssh2');

// Lists one directory. `remotePath` empty/undefined resolves to the SSH
// user's home directory (via SFTP realpath), same starting point a fresh
// SSH login would land in.
function listRemoteDirectory({ host, port, username, authMethod, password, privateKey, remotePath }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      conn.end();
      if (err) reject(err);
      else resolve(result);
    };

    const connectConfig = {
      host,
      port: port || 22,
      username,
      readyTimeout: 15000,
    };
    if (authMethod === 'key') {
      connectConfig.privateKey = privateKey;
    } else {
      connectConfig.password = password;
    }

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { finish(err); return; }
        sftp.realpath(remotePath || '.', (err2, absPath) => {
          if (err2) { finish(err2); return; }
          sftp.readdir(absPath, (err3, list) => {
            if (err3) { finish(err3); return; }
            const entries = list
              .filter((item) => item.filename !== '.' && item.filename !== '..')
              .map((item) => ({
                name: item.filename,
                isDirectory: typeof item.attrs.isDirectory === 'function' ? item.attrs.isDirectory() : false,
              }))
              .sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || a.name.localeCompare(b.name));
            finish(null, { path: absPath, entries });
          });
        });
      });
    });

    conn.on('error', (err) => finish(err));
    conn.connect(connectConfig);
  });
}

module.exports = {
  listRemoteDirectory,
};

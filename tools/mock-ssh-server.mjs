/**
 * Development-only mock of computer B.
 *
 * Provides an SSH server that:
 *  - accepts any password or public key (test harness only),
 *  - implements direct-tcpip forwarding to local TCP targets,
 *  - simulates the Windows firewall commands TunnelDesk issues.
 *
 * Usage: node tools/mock-ssh-server.mjs [--port 2222]
 */
import net from 'node:net';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 2222;
const hostKeys = [utils.generateKeyPairSync('rsa', { bits: 2048 }).private];

/** @type {Map<string, Set<string>>} ruleName -> directions */
const rules = new Map();

function decodeCommand(command) {
  const marker = '-EncodedCommand ';
  const index = command.indexOf(marker);
  if (index < 0) return command;
  const encoded = command.slice(index + marker.length).trim();
  try {
    return Buffer.from(encoded, 'base64').toString('utf16le');
  } catch {
    return command;
  }
}

function handleExec(command) {
  const script = decodeCommand(command);
  const names = [...script.matchAll(/TunnelDesk-[A-Za-z0-9_]+/g)].map((match) => match[0]);
  const unique = [...new Set(names)];

  if (script.includes('authorized_keys')) {
    return ['KEY_OK\nELEVATED=yes\nUSER=demo\nHOST=DEMO-B\n', 0];
  }

  if (script.includes('Get-NetFirewallRule')) {
    const lines = [];
    for (const [name, directions] of rules) {
      for (const direction of directions) lines.push(`${name}|${direction}|True`);
    }
    return [`${lines.join('\r\n')}\r\n`, 0];
  }

  if (script.includes('Remove-NetFirewallRule') && script.includes('New-NetFirewallRule')) {
    for (const name of unique) rules.set(name, new Set(['Inbound', 'Outbound']));
    return ['RULE_OK\n', 0];
  }

  if (script.includes('Remove-NetFirewallRule')) {
    for (const name of unique) rules.delete(name);
    return ['DELETED\n', 0];
  }

  if (script.includes('Write-Output') && unique.length === 0) {
    return ['OK\n', 0];
  }

  return ['', 0];
}

const server = new Server({ hostKeys }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' || ctx.method === 'publickey' || ctx.method === 'keyboard-interactive') {
      ctx.accept();
    } else {
      ctx.reject();
    }
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        const [stdout, code] = handleExec(info.command ?? '');
        stream.write(stdout);
        stream.exit(code);
        stream.end();
      });
      session.on('pty', (acceptPty) => acceptPty && acceptPty());
      session.on('shell', (acceptShell) => {
        const stream = acceptShell();
        stream.write('mock-b ready\r\n');
      });
    });

    client.on('tcpip', (accept, reject, info) => {
      const upstream = net.connect({ host: info.destIP, port: info.destPort });
      upstream.once('connect', () => {
        const channel = accept();
        channel.pipe(upstream).pipe(channel);
        channel.on('error', () => upstream.destroy());
        upstream.on('error', () => channel.destroy());
        console.log(`[mock-b] direct-tcpip ${info.destIP}:${info.destPort}`);
      });
      upstream.once('error', (error) => {
        console.log(`[mock-b] direct-tcpip refused ${info.destIP}:${info.destPort} (${error.code})`);
        reject();
      });
    });
  });

  client.on('error', () => undefined);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-b] SSH server listening on 127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

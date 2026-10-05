const { spawn } = require('child_process');

function startTunnel() {
  console.log('[TunnelKeeper] Starting serveo tunnel...');
  const proc = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-R', '80:localhost:4000', 'serveo.net'], {
    shell: true,
    stdio: 'inherit'
  });

  proc.on('close', (code) => {
    console.log(`[TunnelKeeper] Serveo tunnel exited with code ${code}. Reconnecting in 3s...`);
    setTimeout(startTunnel, 3000);
  });

  proc.on('error', (err) => {
    console.error('[TunnelKeeper] Tunnel error:', err.message);
    setTimeout(startTunnel, 5000);
  });
}

startTunnel();

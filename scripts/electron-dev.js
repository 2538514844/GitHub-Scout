const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const waitOn = require('wait-on');

const projectRoot = path.resolve(__dirname, '..');
const electronBinary = require('electron');
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

async function findAvailablePort(startPort, attempts = 20) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const isFree = await new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });

    if (isFree) {
      return port;
    }
  }

  throw new Error(`No available dev port found starting from ${startPort}`);
}

async function main() {
  const port = await findAvailablePort(5290);
  const devServerUrl = `http://127.0.0.1:${port}`;
  const sharedEnv = {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devServerUrl,
  };

  console.log(`[electron:dev] Using dev server ${devServerUrl}`);

  const vite = spawn(
    process.execPath,
    [viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: projectRoot,
      env: sharedEnv,
      stdio: 'inherit',
    },
  );

  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (!vite.killed) {
      vite.kill();
    }

    process.exit(code);
  };

  vite.on('exit', (code) => {
    if (!shuttingDown) {
      process.exit(code || 0);
    }
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await waitOn({
    resources: [devServerUrl],
    timeout: 120000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  const electron = spawn(electronBinary, ['.'], {
    cwd: projectRoot,
    env: sharedEnv,
    stdio: 'inherit',
  });

  electron.on('exit', (code) => {
    if (!vite.killed) {
      vite.kill();
    }
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error('[electron:dev] Failed to start:', error);
  process.exit(1);
});

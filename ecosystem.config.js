// PM2 process definitions for the PAROL6 / custom-arm control stack.
//
// Paths are resolved relative to this file (via __dirname) so this works
// wherever the repo is checked out - it no longer assumes a specific
// developer's home directory or OS.
//
// The frontend runs in PRODUCTION mode (`next build` once, then `next
// start`), not `next dev`. On a Raspberry Pi Zero 2 W (512MB RAM, quad-core
// Cortex-A53) `next dev`'s on-demand compiler is slow and memory-hungry;
// a production build is far lighter at runtime. Build once after pulling
// changes:
//
//   cd frontend && npm ci && npm run build
//
// then (re)start PM2. If you're iterating on the frontend itself, run
// `npm run dev` by hand in a terminal instead of through PM2.

const path = require('path');

const ROOT = __dirname;
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const COMMANDER_DIR = path.join(ROOT, 'commander');
const API_DIR = path.join(ROOT, 'api');
const LOG_DIR = path.join(ROOT, 'logs', 'pm2');

function logs(name) {
  return {
    error_file: path.join(LOG_DIR, `${name}-error.log`),
    out_file: path.join(LOG_DIR, `${name}-out.log`),
  };
}

module.exports = {
  apps: [
    {
      name: 'parol-nextjs',
      script: 'npm',
      args: 'run start',
      cwd: FRONTEND_DIR,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      instances: 1,
      ...logs('parol-nextjs'),
    },
    {
      name: 'parol-commander',
      script: 'commander.py',
      interpreter: 'python3',
      cwd: COMMANDER_DIR,
      env: {
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: ROOT,
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      instances: 1,
      ...logs('parol-commander'),
    },
    {
      name: 'parol-api',
      script: 'fastapi_server.py',
      interpreter: 'python3',
      cwd: API_DIR,
      env: {
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: ROOT,
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      instances: 1,
      ...logs('parol-api'),
    },
  ],
};

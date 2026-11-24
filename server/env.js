// Environment validation. Fails fast and loudly (repo-scaffold §7).
// Secrets never reach the client (NFR-SEC-006); the client learns integration availability from
// the health endpoint, never from env.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, '..');

const DEFAULTS = {
  JARVIS_PORT: '7701',
  JARVIS_LOG_LEVEL: 'info',
  JARVIS_DB_PATH: join(PROJECT_ROOT, 'data', 'jarvis.db'),
  JARVIS_MODEL_TRANSPORT: 'fixture',
  SANDBOX_RUNTIME: 'local',
  JARVIS_WORKSPACE_ROOT: join(PROJECT_ROOT, 'data', 'workspaces'),
};

const ALLOWED = {
  JARVIS_LOG_LEVEL: ['error', 'warn', 'info', 'debug'],
  JARVIS_MODEL_TRANSPORT: ['fixture', 'bedrock'],
  SANDBOX_RUNTIME: ['local', 'docker'],
};

export function loadEnv() {
  const problems = [];
  const env = {};

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = process.env[key];
    env[key] = raw && raw.trim() ? raw.trim() : fallback;
    if (ALLOWED[key] && !ALLOWED[key].includes(env[key])) {
      problems.push(`${key}="${env[key]}" is not one of: ${ALLOWED[key].join(', ')}`);
    }
  }

  const port = Number.parseInt(env.JARVIS_PORT, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    problems.push(`JARVIS_PORT="${env.JARVIS_PORT}" is not a valid port between 1024 and 65535`);
  }
  env.port = port;

  env.sampleRepoRoot = join(PROJECT_ROOT, 'sample-repo');
  env.webRoot = join(PROJECT_ROOT, 'web');
  env.dataRoot = join(PROJECT_ROOT, 'data');

  if (problems.length) {
    console.error('\nEnvironment is invalid:\n' + problems.map((p) => `  • ${p}`).join('\n') + '\n');
    process.exit(1);
  }

  // ADR-020 / FR-API-011: `actor` is the OS-authenticated user, resolved ONCE at startup and
  // stamped on every human decision, approval and score. The spec is explicit that this exists
  // from the first commit because attribution cannot be retrofitted onto an audit trail that
  // never captured it.
  env.actor = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'unknown-user';

  return env;
}

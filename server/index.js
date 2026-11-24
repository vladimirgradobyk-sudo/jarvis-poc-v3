// Process bootstrap.
//
// Order matters and is deliberate: env → config (REFUSE TO START if invalid) → database →
// registry → sandbox → engine → routes → listen. The server must never come up in a degraded
// configuration state (CAP-ADMIN-01, repo-scaffold §6.1 rule 1).

import { loadEnv } from './env.js';
import { loadConfig } from './config/loader.js';
import { ConfigError } from './config/validator.js';
import { openDb, closeDb } from './persistence/db.js';
import { ModelRegistry } from './providers/registry.js';
import { SandboxExecutor } from './sandbox/executor.js';
import { CouncilEngine } from './council/engine.js';
import { App } from './app.js';
import { registerRoutes } from './api/routes.js';
import { listEventsSince, maxSeq } from './persistence/repos/runs.repo.js';

const env = loadEnv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}`);
    console.error('The server will not start until these are resolved (CAP-ADMIN-01).\n');
    process.exit(1);
  }
  throw err;
}

openDb(env.JARVIS_DB_PATH);

const registry = new ModelRegistry(config.models, env.JARVIS_MODEL_TRANSPORT);
const sandbox = new SandboxExecutor({
  runtimeName: env.SANDBOX_RUNTIME,
  sampleRepoRoot: env.sampleRepoRoot,
  dataRoot: env.dataRoot,
});

const app = new App({ webRoot: env.webRoot, logLevel: env.JARVIS_LOG_LEVEL });

const engine = new CouncilEngine({
  config,
  registry,
  sandbox,
  emit: (event) => app.broadcast(event),
});

// ── SSE stream (FR-EVT-001/002, FR-API-020..026) ────────────────────────────────────────
// One multiplexed stream per session. Registered before the generic routes so it can take over
// the response rather than returning JSON.
app.get('/api/stream', ({ req, res }) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const lastId = Number.parseInt(req.headers['last-event-id'] ?? '0', 10) || 0;
  app.addSseClient(res, lastId);

  // Sent first on every connect, so the client knows where the stream starts.
  res.write(`event: stream.ready\ndata: ${JSON.stringify({ seq: maxSeq(), replayedFrom: lastId })}\n\n`);

  // FR-API-021: on Last-Event-ID, replay retained events with a greater seq IN ORDER, then
  // resume live, with no duplication and no gaps. This is what makes reconnect-and-replay work
  // and why the UI can be a pure projection of the event log.
  if (lastId > 0) {
    for (const ev of listEventsSince(lastId)) {
      res.write(
        `id: ${ev.seq}\nevent: ${ev.type}\n` +
        `data: ${JSON.stringify({ runId: ev.runId, ...ev.payload, at: ev.createdAt, replayed: true })}\n\n`
      );
    }
  }
});

registerRoutes(app, { config, registry, engine, sandbox, env });

const server = app.listen(env.port);

server.on('listening', () => {
  const t = registry.transportName;
  console.log('');
  console.log('  JARVIS — AI Delivery Lifecycle Assistant');
  console.log('  Proof of concept · not for production use');
  console.log('');
  console.log(`  →  http://127.0.0.1:${env.port}`);
  console.log('');
  console.log(`  actor          ${env.actor}  (OS user)`);
  console.log(`  config         ${config.configHash}`);
  console.log(`  transport      ${t}${t === 'fixture' ? '  (deterministic, no model calls, no cost)' : '  (REAL MODEL CALLS — billed)'}`);
  console.log(`  sandbox        ${env.SANDBOX_RUNTIME}`);
  console.log(`  skills         ${config.skills.length}  ·  agents ${config.agents.length}  ·  stages ${config.stages.length}`);
  console.log(`  budget         ${config.budget.perRunPremiumRequests} premium requests/run · ${config.budget.perUserDailyPremiumRequests}/day · warn at ${config.budget.warnPercent}%`);
  console.log('');
  console.log('  Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${env.port} is already in use. Stop the other process or set JARVIS_PORT.\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  server.close(() => { closeDb(); process.exit(0); });
  // Runs are server-owned and persisted after every transition, so an abrupt exit loses no
  // settled candidate (FR-COUNCIL-001, NFR-REL-003).
  setTimeout(() => { closeDb(); process.exit(0); }, 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

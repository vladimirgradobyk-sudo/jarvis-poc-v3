// API Layer (WP-03). node:http — no Express (deviation DV-01).
//
// Responsibilities: routing, schema validation before any side effect, the canonical error
// envelope on every non-2xx, CSRF, correlation IDs, loopback-only binding, and the single SSE
// stream. It accepts NO policy decision from the client (FR-API-002).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, { requirementId = null, retryable = false, detail = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.requirementId = requirementId;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/** api-contract §2.2, the stable problem-code → HTTP mapping. */
export const PROBLEM = {
  validation_failed:        { status: 422, retryable: false },
  not_found:                { status: 404, retryable: false },
  invalid_state:            { status: 409, retryable: false },
  duplicate_model:          { status: 422, retryable: false },
  model_unavailable:        { status: 422, retryable: false },
  writer_count_out_of_range:{ status: 422, retryable: false },
  budget_exceeded:          { status: 402, retryable: false },
  sandbox_unavailable:      { status: 503, retryable: false },
  approval_required:        { status: 403, retryable: false },
  approval_stale:           { status: 409, retryable: false },
  approval_consumed:        { status: 409, retryable: false },
  proposal_superseded:      { status: 409, retryable: false },
  placeholders_present:     { status: 422, retryable: false },
  scorecard_incomplete:     { status: 422, retryable: false },
  secret_scan_findings:     { status: 422, retryable: false },
  path_rejected:            { status: 422, retryable: false },
  injection_flagged:        { status: 422, retryable: false },
  external_system_error:    { status: 502, retryable: true },
  external_partial_failure: { status: 207, retryable: true },
  idempotency_key_reused:   { status: 422, retryable: false },
  csrf_failed:              { status: 403, retryable: false },
  config_invalid:           { status: 500, retryable: false },
  internal_error:           { status: 500, retryable: true },
};

export function fail(code, message, extra = {}) {
  const p = PROBLEM[code] ?? PROBLEM.internal_error;
  throw new ApiError(extra.status ?? p.status, code, message, { retryable: p.retryable, ...extra });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

export class App {
  constructor({ webRoot, logLevel }) {
    this.routes = [];
    this.webRoot = webRoot;
    this.logLevel = logLevel;
    this.csrfToken = randomBytes(24).toString('hex');
    this.sseClients = new Set();
  }

  /** Register a route. `path` may contain `:param` segments. */
  on(method, path, handler) {
    const names = [];
    const pattern = new RegExp(
      '^' +
        path
          .split('/')
          .map((seg) => {
            if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            names.push(seg.slice(1));
            return '([^/]+)';
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, pattern, names, handler, path });
    return this;
  }

  get(p, h) { return this.on('GET', p, h); }
  post(p, h) { return this.on('POST', p, h); }
  put(p, h) { return this.on('PUT', p, h); }

  // ── SSE (FR-EVT-001/002, FR-API-020..026) ───────────────────────────────────────────────

  addSseClient(res, lastEventId) {
    const client = { res, id: randomUUID() };
    this.sseClients.add(client);
    res.on('close', () => this.sseClients.delete(client));
    return client;
  }

  /** Fan out one event to every connected client. `seq` becomes the SSE `id:` field. */
  broadcast(event) {
    const frame =
      `id: ${event.seq}\n` +
      `event: ${event.type}\n` +
      `data: ${JSON.stringify({ runId: event.runId, ...event.payload, at: event.createdAt })}\n\n`;
    for (const c of this.sseClients) {
      try { c.res.write(frame); } catch { this.sseClients.delete(c); }
    }
  }

  heartbeat() {
    // FR-API-024: a comment heartbeat every 15 s keeps proxies and the browser from idling out.
    for (const c of this.sseClients) {
      try { c.res.write(': heartbeat\n\n'); } catch { this.sseClients.delete(c); }
    }
  }

  // ── request handling ───────────────────────────────────────────────────────────────────

  async handle(req, res) {
    const correlationId = req.headers['x-correlation-id'] || `cor_${randomUUID().slice(0, 12)}`;
    res.setHeader('X-Correlation-Id', correlationId);
    // No cross-origin use: the client is served from the same origin, so no CORS policy exists.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      // FR-API-010: bind to loopback and REJECT a request whose Host is not loopback. This is
      // what keeps a single-user local tool from becoming a network service by accident.
      const host = (req.headers.host ?? '').split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
        throw new ApiError(403, 'approval_required',
          `Host "${host}" is not loopback. JARVIS binds to 127.0.0.1 only and is not network-accessible (DEC-01).`);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      // Static assets and the SPA shell.
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        return await this.serveStatic(path, res);
      }

      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!route) {
        throw new ApiError(404, 'not_found', `No route for ${req.method} ${path}.`);
      }

      const m = route.pattern.exec(path);
      const params = {};
      route.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });

      let body = null;
      if (req.method !== 'GET') {
        body = await readJsonBody(req);
        // FR-API-013: a CSRF token is required on all state-changing requests, because the
        // session is cookie-scoped.
        const token = req.headers['x-csrf-token'];
        if (token !== this.csrfToken) {
          throw new ApiError(403, 'csrf_failed',
            'Missing or invalid CSRF token. Reload the page to obtain a new one.');
        }
      }

      const ctx = { req, res, url, params, body, query: url.searchParams, correlationId };
      const result = await route.handler(ctx);

      if (res.headersSent || res.writableEnded) return;   // handler took over (SSE, stream)
      const status = result?.__status ?? 200;
      const payload = result?.__status ? result.body : result;
      this.sendJson(res, status, payload);
    } catch (err) {
      this.sendError(res, err, correlationId);
    }
  }

  sendJson(res, status, payload) {
    const text = JSON.stringify(payload ?? null);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  /** FR-API-005: the canonical error envelope on EVERY non-2xx response, without exception. */
  sendError(res, err, correlationId) {
    const isApi = err instanceof ApiError;
    const code = isApi ? err.code : (err.code && PROBLEM[err.code] ? err.code : 'internal_error');
    const spec = PROBLEM[code] ?? PROBLEM.internal_error;
    const status = isApi ? err.status : spec.status;

    if (!isApi && this.logLevel !== 'error') {
      console.error(`[${correlationId}] ${err.stack ?? err.message}`);
    }

    const envelope = {
      error: {
        code,
        message: err.message || 'Unexpected error.',
        requirementId: err.requirementId ?? null,
        retryable: spec.retryable,
        // FR-API-003: never return a credential, token or secret — including in error detail.
        detail: err.detail ?? null,
        correlationId,
      },
    };
    if (res.headersSent) { try { res.end(); } catch {} return; }
    this.sendJson(res, status, envelope);
  }

  async serveStatic(path, res) {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    // Normalise and confine: a static handler is a traversal surface.
    const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    let file = join(this.webRoot, safe);
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch {
      // Unknown non-API path → the SPA shell, so client-side routes deep-link.
      file = join(this.webRoot, 'index.html');
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        // `no-store` so the browser always fetches the current JS/CSS/HTML. This is a local tool
        // under active change; serving a stale cached module is a worse failure than a re-fetch.
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  }

  listen(port) {
    const server = createServer((req, res) => { this.handle(req, res); });
    // Loopback bind. Not 0.0.0.0 — DEC-01 is single-user, not network-accessible.
    server.listen(port, '127.0.0.1');
    setInterval(() => this.heartbeat(), 15000).unref();
    return server;
  }
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'validation_failed', 'Request body exceeds 2 MB.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(422, 'validation_failed', 'Request body is not valid JSON.');
  }
}

export const created = (body) => ({ __status: 201, body });
export const accepted = (body) => ({ __status: 202, body });
export const multiStatus = (body) => ({ __status: 207, body });

// Typed-ish API client. One place that knows about HTTP.

export class ApiError extends Error {
  constructor(envelope, status) {
    super(envelope?.error?.message ?? `Request failed (${status}).`);
    this.status = status;
    this.code = envelope?.error?.code ?? 'internal_error';
    this.requirementId = envelope?.error?.requirementId ?? null;
    this.detail = envelope?.error?.detail ?? null;
    this.correlationId = envelope?.error?.correlationId ?? null;
  }
}

let csrfToken = null;
export function setCsrf(t) { csrfToken = t; }

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(csrfToken && method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  // 207 is a SUCCESSFUL partial publish, not an error — the caller inspects per-item results.
  if (!res.ok && res.status !== 207) throw new ApiError(json, res.status);
  return json;
}

export const api = {
  get:  (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put:  (p, b) => request('PUT', p, b ?? {}),

  bootstrap:        () => api.get('/api/v1/bootstrap'),
  health:           () => api.get('/api/v1/health'),
  skill:            (id) => api.get(`/api/v1/catalogue/skills/${id}`),
  searchSkills:     (q) => api.get(`/api/v1/catalogue/search?q=${encodeURIComponent(q)}`),
  artifacts:        (kinds, skills) => {
                      const p = new URLSearchParams();
                      if (kinds?.length) p.set('kinds', kinds.join(','));
                      if (skills?.length) p.set('skills', skills.join(','));
                      const q = p.toString();
                      return api.get(`/api/v1/artifacts${q ? `?${q}` : ''}`);
                    },

  estimate:         (b) => api.post('/api/v1/runs/estimate', b),
  createRun:        (b) => api.post('/api/v1/runs', b),
  generate:         (id, b) => api.post(`/api/v1/runs/${id}/generate`, b),
  listRuns:         (q = '') => api.get(`/api/v1/runs${q}`),
  run:              (id) => api.get(`/api/v1/runs/${id}`),
  cancelRun:        (id) => api.post(`/api/v1/runs/${id}/cancel`, { reason: 'Cancelled by user' }),
  decide:           (id, b) => api.post(`/api/v1/runs/${id}/decision`, b),
  editCandidate:    (id, b) => api.post(`/api/v1/candidates/${id}/edit`, b),

  scorecard:        (runId) => api.get(`/api/v1/runs/${runId}/scorecard`),
  scoreSection:     (cardId, sectionId, b) => api.put(`/api/v1/scorecards/${cardId}/sections/${sectionId}`, b),
  completeScorecard:(cardId) => api.post(`/api/v1/scorecards/${cardId}/complete`, {}),

  createProposal:   (runId, b) => api.post(`/api/v1/runs/${runId}/proposals`, b),
  proposal:         (id) => api.get(`/api/v1/proposals/${id}`),
  revalidate:       (id) => api.post(`/api/v1/proposals/${id}/revalidate`, {}),
  approve:          (id, b) => api.post(`/api/v1/proposals/${id}/approve`, b),
  reject:           (id, b) => api.post(`/api/v1/proposals/${id}/reject`, b),
  publish:          (id, b) => api.post(`/api/v1/proposals/${id}/publish`, b),

  provenance:       (runId) => api.get(`/api/v1/runs/${runId}/provenance`),
  budget:           () => api.get('/api/v1/budget'),
  adminUsage:       (q = '') => api.get(`/api/v1/admin/usage${q}`),
  adminRuns:        () => api.get('/api/v1/admin/runs'),
  adminEstimate:    (b) => api.post('/api/v1/admin/estimate', b),
  audit:            (q = '') => api.get(`/api/v1/audit${q}`),

  sor:              () => api.get('/api/v1/sor'),
  sorPage:          (id) => api.get(`/api/v1/sor/confluence/${id}`),
  sorIssue:         (k) => api.get(`/api/v1/sor/jira/${k}`),
  sorPr:            (id) => api.get(`/api/v1/sor/pr/${id}`),
  sorTouch:         (id) => api.post(`/api/v1/sor/confluence/${id}/touch`, {}),
};

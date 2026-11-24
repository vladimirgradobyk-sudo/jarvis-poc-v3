// NFR-SEC-001 / AM-14 / non-negotiable 4: never put secrets, credentials or PII into prompts,
// logs, artifacts, telemetry or events. REDACT AT THE BOUNDARY, not downstream.
//
// This module is applied where data CROSSES a boundary — inbound inputs before they are stored
// or sent to a provider, and outbound event payloads before they are persisted or streamed.

const PATTERNS = [
  // Credentials and tokens
  { id: 'aws_access_key',   re: /\bAKIA[0-9A-Z]{16}\b/g,                              label: 'AWS access key' },
  { id: 'aws_secret',       re: /\b[A-Za-z0-9/+=]{40}\b(?=\s*$|["',\s])/g,            label: 'possible AWS secret', minEntropy: true },
  { id: 'private_key',      re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g, label: 'private key' },
  { id: 'bearer',           re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,              label: 'bearer token' },
  { id: 'github_pat',       re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                    label: 'GitHub token' },
  { id: 'anthropic_key',    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,                     label: 'Anthropic API key' },
  { id: 'generic_api_key',  re: /\b(?:api[_-]?key|apikey|secret|password|passwd|pwd|token)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi, label: 'credential assignment' },
  { id: 'jdbc_password',    re: /(jdbc:[^\s;]*[;&]password=)([^\s;&]+)/gi,            label: 'JDBC password' },
  { id: 'basic_auth_url',   re: /\b([a-z][a-z0-9+.-]*:\/\/)([^:/?#\s]+):([^@/?#\s]+)@/gi, label: 'credentials in URL' },

  // Cardholder data — DEC-17 forbids PCI data reaching a model provider outright.
  { id: 'pan',              re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|2(?:2[2-9]|[3-6][0-9]|7[01])[0-9]{12}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, label: 'card number', luhn: true },
  { id: 'cvv_labelled',     re: /\b(?:cvv|cvc|cid)\s*[:=]?\s*\d{3,4}\b/gi,            label: 'card verification value' },

  // Personal data
  { id: 'ssn',              re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, label: 'national identifier' },
  { id: 'iban',             re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,                  label: 'IBAN' },
];

const MASK = '[REDACTED]';

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function shannon(s) {
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  return -Object.values(freq).reduce((h, c) => {
    const p = c / s.length;
    return h + p * Math.log2(p);
  }, 0);
}

/**
 * Redact a string. Returns the cleaned text and what was found — the FINDINGS carry only the
 * pattern label and position, never the matched value, so the audit trail stays content-free
 * (NFR-OBS-001).
 */
export function redactText(input) {
  if (typeof input !== 'string' || input.length === 0) return { text: input, findings: [] };
  let text = input;
  const findings = [];

  for (const p of PATTERNS) {
    text = text.replace(p.re, (match, ...groups) => {
      // Luhn-check card candidates so an order number does not read as a PAN.
      if (p.luhn && !luhnValid(match.replace(/\D/g, ''))) return match;
      // High-entropy gate for the loose base64 pattern, so prose is not mangled.
      if (p.minEntropy && shannon(match) < 4.2) return match;

      findings.push({ id: p.id, label: p.label, index: -1 });

      if (p.id === 'generic_api_key') {
        const value = groups.find((g) => typeof g === 'string');
        return value ? match.replace(value, MASK) : MASK;
      }
      if (p.id === 'jdbc_password') return `${groups[0]}${MASK}`;
      if (p.id === 'basic_auth_url') return `${groups[0]}${groups[1]}:${MASK}@`;
      return MASK;
    });
  }
  return { text, findings };
}

/** Deep-redact any structure before it is stored, logged, streamed or sent to a provider. */
export function redactDeep(value) {
  const findings = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactText(v);
      findings.push(...r.findings);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        // A key whose NAME says secret is masked wholesale regardless of its value's shape.
        if (/^(password|passwd|secret|token|apikey|api_key|authorization|cookie|private_?key)$/i.test(k)) {
          out[k] = MASK;
          findings.push({ id: 'sensitive_key_name', label: `field "${k}"`, index: -1 });
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), findings };
}

/**
 * NFR-SEC-007 / FR-EXE-004: scan GENERATED CODE for secrets before a PR is proposed. A positive
 * finding BLOCKS the proposal. Returns located findings (file and line) because the error
 * message must name where the problem is.
 */
export function scanForSecrets(files) {
  const findings = [];
  for (const f of files) {
    const lines = String(f.afterBody ?? '').split('\n');
    for (const [i, line] of lines.entries()) {
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (!m) continue;
        if (p.luhn && !luhnValid(m[0].replace(/\D/g, ''))) continue;
        if (p.minEntropy && shannon(m[0]) < 4.2) continue;
        findings.push({
          path: f.path,
          line: i + 1,
          patternId: p.id,
          label: p.label,
          // The matched value is NEVER included — that would move the secret into the audit log.
          message: `A credential-like string (${p.label}) was found in ${f.path}:${i + 1}. This change cannot be proposed as a PR.`,
        });
      }
    }
  }
  return findings;
}

/**
 * AIR-PROMPT-002: detect content attempting to act as an instruction. Repository content,
 * retrieved knowledge and model output are untrusted DATA in a separate channel; if it looks
 * like an instruction, flag it (non-negotiable 5).
 */
const INJECTION_PATTERNS = [
  /ignore (?:all |any )?(?:your |the )?(?:previous |prior |above )?instructions?/i,
  /disregard (?:all |any )?(?:previous|prior|the above)/i,
  /you are now (?:a|an|the)\b/i,
  /\bsystem\s*prompt\b/i,
  /<\/?(?:system|policy|instructions?)>/i,
  /\bpublish (?:this|it) (?:immediately|now|without)/i,
  /\b(?:approve|merge|push|commit) (?:this|it) (?:immediately|now|without approval)/i,
  /without (?:asking for |requiring )?(?:human )?(?:approval|confirmation|review)/i,
  /\bprint (?:your|the) (?:instructions|system prompt|credentials)/i,
];

export function detectInjection(text) {
  if (typeof text !== 'string') return [];
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: re.source, excerpt: m[0].slice(0, 80) });
  }
  return hits;
}

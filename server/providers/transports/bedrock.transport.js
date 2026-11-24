// Bedrock transport — OPTIONAL, opt-in via JARVIS_MODEL_TRANSPORT=bedrock.
//
// Why it exists: AD-MODEL and non-negotiable 6 make the provider abstraction mandatory, and an
// abstraction with exactly one implementation has not been shown to abstract anything. This is
// the second implementation. It proves the seam is real.
//
// Why it is NOT the default: A-07 (≥3 approved model families) is unconfirmed on this
// workstation — only the Anthropic family is reachable here — and FR-COUNCIL-004 requires
// distinct families. Running the council on Bedrock today would fail that check honestly rather
// than silently substituting models, which is the correct behaviour and a poor demo.
//
// R1 replaces this with the Copilot CLI over ACP (AD-INVOKE-R1); the interface is unchanged.

import { createSign } from 'node:crypto';
import { createHash, createHmac } from 'node:crypto';

const SERVICE = 'bedrock';

function env(name, fallback = null) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** SigV4. Implemented here rather than via the AWS SDK to keep the zero-dependency promise. */
function sign(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function signatureKey(secret, date, region, service) {
  return sign(sign(sign(sign('AWS4' + secret, date), region), service), 'aws4_request');
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function credentials() {
  const accessKey = env('AWS_ACCESS_KEY_ID');
  const secretKey = env('AWS_SECRET_ACCESS_KEY');
  const sessionToken = env('AWS_SESSION_TOKEN');
  if (!accessKey || !secretKey) {
    throw new Error(
      'Bedrock transport selected but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in the ' +
      'environment. This transport reads credentials from the environment only — it does not read ' +
      '~/.aws. Export credentials for the AWS_PROFILE, or set JARVIS_MODEL_TRANSPORT=fixture.'
    );
  }
  return { accessKey, secretKey, sessionToken };
}

async function invoke({ modelId, system, messages, maxTokens = 8000 }) {
  const region = env('AWS_REGION', 'us-east-1');
  const { accessKey, secretKey, sessionToken } = credentials();

  const base = env('ANTHROPIC_BEDROCK_BASE_URL', `https://bedrock-runtime.${region}.amazonaws.com`);
  const url = new URL(`${base.replace(/\/$/, '')}/model/${encodeURIComponent(modelId)}/invoke`);

  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system,
    messages,
  });

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const headers = {
    'content-type': 'application/json',
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [
    'POST', url.pathname, url.search.slice(1),
    canonicalHeaders, signedHeaders.join(';'), payloadHash,
  ].join('\n');

  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signatureKey(secretKey, date, region, SERVICE))
    .update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

  const res = await fetch(url, { method: 'POST', headers, body: payload });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // The message is surfaced to the user, so it must not echo credentials (FR-API-003).
    throw new Error(`Bedrock returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      calls: 1,
    },
  };
}

function channels({ policy, template, context, user }) {
  // AIR-PROMPT-001: policy is the ONLY instruction channel. Everything else is delimited,
  // labelled data. Repository content, retrieved knowledge and prior model output are never
  // instructions, and the delimiters are what let the model tell the difference.
  const parts = [];
  if (template) parts.push(`<task>\n${template}\n</task>`);
  if (context) parts.push(`<untrusted_context>\n${context}\n</untrusted_context>`);
  if (user) parts.push(`<untrusted_user_input>\n${user}\n</untrusted_user_input>`);
  return { system: policy, userContent: parts.join('\n\n') };
}

function parseSections(text, template) {
  const sections = [];
  for (const def of template.sections) {
    const re = new RegExp(`^##\\s*${def.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
    const m = re.exec(text);
    if (!m) { sections.push({ id: def.id, heading: def.heading, body: '' }); continue; }
    const start = m.index + m[0].length;
    const next = /^##\s+/im.exec(text.slice(start));
    sections.push({
      id: def.id,
      heading: def.heading,
      body: text.slice(start, next ? start + next.index : undefined).trim(),
    });
  }
  return sections;
}

const PLACEHOLDER_RE = /TBD\s*\[UNKNOWN[^\]]*\]|\bTBD\b/gi;

function scanPlaceholders(sections) {
  const out = [];
  for (const s of sections) {
    for (const m of s.body.matchAll(PLACEHOLDER_RE)) {
      out.push({ sectionId: s.id, sectionHeading: s.heading, text: m[0] });
    }
  }
  return out;
}

function scanCitations(sections) {
  const out = [];
  for (const s of sections) {
    for (const m of s.body.matchAll(/\[Source:\s*([^\]]+)\]/g)) {
      out.push({ sectionId: s.id, sourceLabel: m[1].trim() });
    }
  }
  return out;
}

export const bedrockTransport = {
  name: 'bedrock',
  describe: () => 'Amazon Bedrock InvokeModel over SigV4. Real model calls — real cost.',

  plannedSteps({ artifactKind }) {
    return artifactKind === 'code_plan'
      ? ['Assembling channels', 'Calling model', 'Parsing plan', 'Checking sequencing']
      : ['Assembling channels', 'Calling model', 'Parsing sections', 'Scanning placeholders'];
  },

  async generate({ template, writerProfile, resolved, inputs, promptText, policyText }) {
    const sectionList = template.sections
      .map((s, i) => `${i + 1}. ## ${s.heading}`)
      .join('\n');
    const { system, userContent } = channels({
      policy: `${policyText}\n\n---\n\n${promptText.writer}\n\n---\n\n${promptText.skill}`,
      template: `Produce the document with EXACTLY these level-2 headings, in this order:\n\n${sectionList}`,
      user: JSON.stringify(inputs, null, 2),
    });

    const { text, usage } = await invoke({
      modelId: resolved.resolvedModel,
      system,
      messages: [{ role: 'user', content: userContent }],
    });

    const sections = parseSections(text, template);
    return {
      body: text,
      sections,
      placeholders: scanPlaceholders(sections),
      citations: scanCitations(sections),
      title: `${template.title}`,
      wordCount: (text.match(/\b[\w'-]+\b/g) ?? []).length,
      usage: { ...usage, premiumRequests: resolved.multiplier },
    };
  },

  async review({ rubric, evaluatorProfile, evaluatorResolved, candidate, isSelf, policyText, promptText }) {
    const criteria = rubric.criteria.map((c) => `- ${c.id} (${c.label}): ${c.guidance}`).join('\n');
    const { system, userContent } = channels({
      policy: `${policyText}\n\n---\n\n${promptText.writer}\n\nYou are now EVALUATING a draft, not writing one.`,
      template:
        `Score the draft 0-100 on each criterion:\n${criteria}\n\n` +
        `Respond with JSON only:\n` +
        `{"overallScore":n,"criterionScores":{"<id>":n,...},"strengths":["..."],"concerns":["..."],"feedback":"..."}` +
        (isSelf ? `\n\nNOTE: this is YOUR OWN draft. Self-reviews are flagged and excluded from the peer average.` : ''),
      context: candidate.body,
    });

    const { text, usage } = await invoke({
      modelId: evaluatorResolved.resolvedModel, system,
      messages: [{ role: 'user', content: userContent }], maxTokens: 3000,
    });

    let parsed;
    try {
      parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      // Model output is untrusted DATA. An unparseable review fails this review only; the
      // phase reports a missing review rather than inventing a score (FR-REV-001).
      throw new Error(`Evaluator ${evaluatorProfile.id} returned an unparseable review.`);
    }
    return {
      overallScore: Math.round(parsed.overallScore ?? 0),
      criterionScores: parsed.criterionScores ?? {},
      strengths: parsed.strengths ?? [],
      concerns: parsed.concerns ?? [],
      feedback: parsed.feedback ?? '',
      usage: { ...usage, premiumRequests: evaluatorResolved.multiplier },
    };
  },

  async adjudicate({ candidates, aggregates, captainMode, captainResolved, policyText, promptText, maxSuggestions }) {
    // Mode controls EXACTLY what the Captain is shown (council-engine-spec §4.2). This is the
    // whole point of recording the mode in provenance: a verdict is uninterpretable without it.
    const evidence = captainMode === 'peer_scored'
      ? JSON.stringify(aggregates, null, 2)
      : candidates.map((c) => `### ${c.id} — ${c.writerDisplayName} (${c.modelDisplayName})\n\n${c.body}`).join('\n\n---\n\n') +
        (captainMode === 'full_context' ? `\n\n### Peer evaluation\n\n${JSON.stringify(aggregates, null, 2)}` : '');

    const { system, userContent } = channels({
      policy: `${policyText}\n\n---\n\n${promptText.captain}`,
      template:
        `Respond with JSON only:\n` +
        `{"winnerCandidateId":"<id>","rationale":"...","fullAnalysis":"...",` +
        `"suggestions":[{"sourceCandidateId":"<id>","targetSectionId":"<id>","text":"..."}]}\n\n` +
        `Cap suggestions at ${maxSuggestions}. EVERY suggestion must name its sourceCandidateId.`,
      context: evidence,
    });

    const { text, usage } = await invoke({
      modelId: captainResolved.resolvedModel, system,
      messages: [{ role: 'user', content: userContent }], maxTokens: 8000,
    });

    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const valid = new Set(candidates.map((c) => c.id));
    return {
      winnerCandidateId: valid.has(parsed.winnerCandidateId) ? parsed.winnerCandidateId : candidates[0].id,
      rationale: parsed.rationale ?? '',
      fullAnalysis: parsed.fullAnalysis ?? parsed.rationale ?? '',
      // Drop any suggestion whose source is not a real candidate: an unattributed suggestion is
      // not actionable (FR-ADJ-002), so it is better removed than shown unverifiable.
      suggestions: (parsed.suggestions ?? [])
        .filter((s) => valid.has(s.sourceCandidateId))
        .slice(0, maxSuggestions)
        .map((s) => ({
          ...s,
          sourceLabel: `From ${candidates.find((c) => c.id === s.sourceCandidateId).writerDisplayName}`,
        })),
      usage: { ...usage, premiumRequests: captainResolved.multiplier },
    };
  },

  async synthesise({ base, suggestions, captainResolved, policyText, template }) {
    const { system, userContent } = channels({
      policy: `${policyText}\n\nYou are applying selected improvements to a base document. Preserve its structure and headings exactly.`,
      template: `Apply these improvements:\n${suggestions.map((s, i) => `${i + 1}. [${s.sourceLabel}] ${s.text}`).join('\n')}`,
      context: base.body,
    });
    const { text, usage } = await invoke({
      modelId: captainResolved.resolvedModel, system,
      messages: [{ role: 'user', content: userContent }], maxTokens: 16000,
    });
    const sections = parseSections(text, template);
    return {
      body: text,
      sections: sections.map((s) => ({ ...s, sourceCandidateId: base.id, sourceLabel: base.writerDisplayName })),
      applied: suggestions.map((s) => ({ suggestionId: s.id, applied: true, sourceCandidateId: s.sourceCandidateId,
                                         change: 'Applied by the Captain during synthesis.' })),
      wordCount: (text.match(/\b[\w'-]+\b/g) ?? []).length,
      usage: { ...usage, premiumRequests: captainResolved.multiplier },
    };
  },
};

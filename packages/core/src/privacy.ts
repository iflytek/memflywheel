/**
 * Privacy pipeline: <private> redaction (soft) and optional obvious-secret refusal.
 *
 * Policy: <private>…</private> → "[REDACTED]" always. Obvious secrets
 * (token / password / api key / cookie / ssh key) cause the write to be refused
 * only when the caller enables the `refuseSecrets` gate.
 */

const PRIVATE_SPAN_RE = /<private>[\s\S]*?<\/private>/gi;

export function redactPrivateSpans(text: string): string {
  return String(text || "").replace(PRIVATE_SPAN_RE, "[REDACTED]");
}

export type SecretKind = "token" | "password" | "api-key" | "cookie" | "ssh-key";

export interface SecretFinding {
  kind: SecretKind;
  excerpt: string;
}

interface SecretRule {
  kind: SecretKind;
  re: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  // OpenSSH / PEM private keys.
  { kind: "ssh-key", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  // Common API key / token prefixes (OpenAI, GitHub, Slack, AWS, Google, Stripe).
  { kind: "api-key", re: /\b(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/ },
  { kind: "token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  // Bearer tokens.
  { kind: "token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i },
  // JWT-shaped tokens.
  { kind: "token", re: /\beyJ[A-Za-z0-9._-]{20,}\b/ },
  // key: value style assignments naming a secret.
  {
    kind: "api-key",
    re: /\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\b\s*[:=]\s*\S{8,}/i,
  },
  { kind: "password", re: /\b(password|passwd|pwd)\b\s*[:=]\s*\S{4,}/i },
  { kind: "cookie", re: /\b(Cookie|Set-Cookie)\b\s*:\s*\S+=\S+/i },
];

function maskExcerpt(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

/** Heuristic scan for obvious secrets. Findings carry only a masked excerpt. */
export function scanSecrets(text: string): SecretFinding[] {
  const input = String(text || "");
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    const m = input.match(rule.re);
    if (m) {
      findings.push({ kind: rule.kind, excerpt: maskExcerpt(m[0]) });
    }
  }
  return findings;
}

export class SecretRefusedError extends Error {
  readonly findings: SecretFinding[];
  constructor(findings: SecretFinding[]) {
    super(
      `refusing to persist memory containing obvious secret(s): ${findings
        .map((f) => f.kind)
        .join(", ")}`,
    );
    this.name = "SecretRefusedError";
    this.findings = findings;
  }
}

/**
 * Redact <private> spans (always, deterministic). When `refuseSecrets` is on,
 * additionally throw SecretRefusedError if any hard secret survives. The hard
 * secret gate is OFF by default — privacy now leans on the extraction prompt,
 * Returns the redacted text.
 */
export function enforceWritePrivacy(
  text: string,
  options?: { refuseSecrets?: boolean },
): string {
  const redacted = redactPrivateSpans(text);
  if (options?.refuseSecrets) {
    const findings = scanSecrets(redacted);
    if (findings.length > 0) {
      throw new SecretRefusedError(findings);
    }
  }
  return redacted;
}

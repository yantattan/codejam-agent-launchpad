import type { Agent, ScanFinding, ScanSeverity, ScanTargetSource, ScanVerdict } from "./types.js";

export interface ScanTarget {
  source: ScanTargetSource;
  path?: string;
  text: string;
}

export interface SemanticJudge {
  classify(input: {
    agentContext: string;
    targets: ScanTarget[];
  }): Promise<ScanFinding[]>;
}

const EXCERPT_RADIUS = 80;
const MAX_EXCERPT_LENGTH = 200;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const raw = prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
  return raw.length > MAX_EXCERPT_LENGTH ? raw.slice(0, MAX_EXCERPT_LENGTH) + "…" : raw;
}

function finding(
  partial: Omit<ScanFinding, "tier">,
): ScanFinding {
  return { tier: "static", ...partial };
}

// --- Technique 1 & 2: disguised instructions and fake system/developer messages ---

const INSTRUCTION_PATTERNS: { regex: RegExp; technique: string; severity: ScanSeverity }[] = [
  {
    regex: /\b(ignore|disregard)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|constraints?|rules?)\b/i,
    technique: "disguised-instruction",
    severity: "malicious",
  },
  {
    regex: /\bnew\s+(instructions?|processing\s+requirements?)\s*:/i,
    technique: "disguised-instruction",
    severity: "suspicious",
  },
  {
    regex: /\b(processing\s+note|editor'?s?\s+note|internal\s+note)\s*:.{0,120}\b(apply|follow|execute)\s+the\s+following/is,
    technique: "disguised-instruction",
    severity: "suspicious",
  },
  {
    regex: /\byou\s+are\s+now\b/i,
    technique: "disguised-instruction",
    severity: "info",
  },
  {
    regex: /\bact\s+as\s+(a|an|the)\b/i,
    technique: "disguised-instruction",
    severity: "info",
  },
];

const FAKE_HEADER_KEYWORDS =
  /^(SYSTEM|ADMIN|ADMINISTRATOR|DEVELOPER|ASSISTANT|CONFIGURATION|PRIORITY|OVERRIDE|ROOT)\b/;
const IMPERATIVE_NEARBY =
  /\b(must|required|comply|override|immediately|mandatory|critical|priority)\b/i;

function detectInstructionPatterns(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { regex, technique, severity } of INSTRUCTION_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      findings.push(
        finding({
          severity,
          technique,
          source: "prompt",
          excerpt: excerptAround(text, match.index, match[0].length),
          detail: "Text reads like an embedded instruction rather than ordinary content.",
        }),
      );
    }
  }
  return findings;
}

function detectFakeSystemMessage(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const looksLikeHeader =
      FAKE_HEADER_KEYWORDS.test(line.toUpperCase()) ||
      (/^[A-Z][A-Z0-9 _-]{3,}$/.test(line) && line === line.toUpperCase());
    if (!looksLikeHeader) continue;
    const windowText = lines.slice(i, i + 5).join(" ");
    const hasImperative = IMPERATIVE_NEARBY.test(windowText);
    const index = text.indexOf(line);
    findings.push(
      finding({
        severity: hasImperative ? "malicious" : "suspicious",
        technique: "fake-system-message",
        source: "prompt",
        excerpt: excerptAround(text, index === -1 ? 0 : index, windowText.length),
        detail: hasImperative
          ? "Content mimics a system/developer message and pairs it with an imperative directive — this text has no real authority over the Agent."
          : "Content mimics a system/developer-style header. Treated as data, not as authoritative.",
      }),
    );
  }
  return findings;
}

// --- Technique 5: invisible characters, homoglyphs, formatting tricks ---

// Built from numeric codepoints rather than literal characters in source,
// since invisible characters can't be visually verified once written to a
// file. Zero-width space/joiners, BOM, word joiner, Mongolian vowel
// separator.
const ZERO_WIDTH_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0xfeff, 0x2060, 0x180e];
const ZERO_WIDTH_CHARS = new RegExp(
  "[" + ZERO_WIDTH_CODEPOINTS.map((code) => String.fromCharCode(code)).join("") + "]",
);
// Bidi override/embedding and isolate control characters — can make
// displayed text order differ from actual character order.
const BIDI_CODEPOINTS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const BIDI_CONTROL_CHARS = new RegExp(
  "[" + BIDI_CODEPOINTS.map((code) => String.fromCharCode(code)).join("") + "]",
);

// Built from numeric codepoints, same reliability reason as above. Common
// Cyrillic/Greek lookalikes for Latin letters (a small, hand-picked table,
// not a full Unicode confusables set — see plan's scope cuts).
const HOMOGLYPH_CODEPOINTS: [number, string][] = [
  [0x0430, "a"], // Cyrillic а
  [0x0435, "e"], // Cyrillic е
  [0x043e, "o"], // Cyrillic о
  [0x0440, "p"], // Cyrillic р
  [0x0441, "c"], // Cyrillic с
  [0x0445, "x"], // Cyrillic х
  [0x0456, "i"], // Cyrillic і
  [0x03bf, "o"], // Greek ο
  [0x0391, "A"], // Greek Α
];
const HOMOGLYPH_CHARS = new RegExp(
  "[" + HOMOGLYPH_CODEPOINTS.map(([code]) => String.fromCharCode(code)).join("") + "]",
);

function detectInvisibleOrHomoglyphChars(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  const zeroWidth = ZERO_WIDTH_CHARS.exec(text);
  if (zeroWidth) {
    findings.push(
      finding({
        severity: "suspicious",
        technique: "invisible-character",
        source: "prompt",
        excerpt: excerptAround(text, zeroWidth.index, 1),
        detail: "Contains zero-width or invisible Unicode characters that don't render but change what the text actually says.",
      }),
    );
  }

  const bidi = BIDI_CONTROL_CHARS.exec(text);
  if (bidi) {
    findings.push(
      finding({
        severity: "suspicious",
        technique: "bidi-control-character",
        source: "prompt",
        excerpt: excerptAround(text, bidi.index, 1),
        detail: "Contains bidirectional-text control characters, which can make displayed text and actual text order differ.",
      }),
    );
  }

  const homoglyph = HOMOGLYPH_CHARS.exec(text);
  if (homoglyph) {
    findings.push(
      finding({
        severity: "suspicious",
        technique: "homoglyph-character",
        source: "prompt",
        excerpt: excerptAround(text, homoglyph.index, 1),
        detail: "Contains look-alike characters from another script (e.g. Cyrillic) substituted for Latin letters.",
      }),
    );
  }

  const normalized = text.normalize("NFKC");
  if (normalized !== text && !homoglyph && !zeroWidth) {
    findings.push(
      finding({
        severity: "info",
        technique: "unicode-normalization-mismatch",
        source: "prompt",
        excerpt: excerptAround(text, 0, Math.min(text.length, 40)),
        detail: "Text changes under standard Unicode normalization, suggesting unusual character forms (fullwidth, compatibility characters, etc).",
      }),
    );
  }

  return findings;
}

// --- Technique 6: encoded content ---

const BASE64_TOKEN = /[A-Za-z0-9+/]{12,}={0,2}/g;
// %XX escapes from a real encodeURIComponent() call are interspersed with
// literal untouched characters (letters/digits/-._~), not back-to-back —
// so this matches a URL-safe-ish token and the pair count is checked
// separately, rather than requiring consecutive %XX with nothing between.
const PERCENT_TOKEN = /[%0-9A-Za-z._~-]{12,}/g;
const PERCENT_PAIR = /%[0-9A-Fa-f]{2}/g;
const MIN_PERCENT_PAIRS = 3;

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code < 0x7f) || char === "\n" || char === "\t") printable++;
  }
  return printable / text.length;
}

function scanDecodedText(decoded: string, source: ScanTargetSource, technique: string): ScanFinding[] {
  const nested = [...detectInstructionPatterns(decoded), ...detectFakeSystemMessage(decoded)];
  return nested.map((item) => ({
    ...item,
    source,
    technique: technique + "+" + item.technique,
    detail: "Decoded content: " + item.detail,
  }));
}

function detectEncodedContent(text: string, source: ScanTargetSource, depth = 0): ScanFinding[] {
  if (depth >= 2) return [];
  const findings: ScanFinding[] = [];

  for (const match of text.matchAll(BASE64_TOKEN)) {
    const token = match[0];
    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (decoded.length < 4 || printableRatio(decoded) < 0.85) continue;
    const nested = scanDecodedText(decoded, source, "base64-encoded");
    if (nested.length > 0) {
      findings.push(...nested);
    } else {
      findings.push(
        finding({
          severity: "info",
          technique: "base64-encoded-content",
          source,
          excerpt: excerptAround(text, match.index ?? 0, token.length),
          detail: "Contains base64-decodable content: \"" + decoded.slice(0, 80) + "\"",
        }),
      );
    }
    findings.push(...detectEncodedContent(decoded, source, depth + 1));
  }

  for (const match of text.matchAll(PERCENT_TOKEN)) {
    const token = match[0];
    const pairCount = (token.match(PERCENT_PAIR) ?? []).length;
    if (pairCount < MIN_PERCENT_PAIRS) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(token);
    } catch {
      continue;
    }
    const nested = scanDecodedText(decoded, source, "url-encoded");
    if (nested.length > 0) {
      findings.push(...nested);
    }
    findings.push(...detectEncodedContent(decoded, source, depth + 1));
  }

  return findings;
}

// --- Orchestration ---

function runStaticChecks(target: ScanTarget): ScanFinding[] {
  const raw = [
    ...detectInstructionPatterns(target.text),
    ...detectFakeSystemMessage(target.text),
    ...detectInvisibleOrHomoglyphChars(target.text),
    ...detectEncodedContent(target.text, target.source),
  ];
  return raw.map((item) => ({
    ...item,
    source: target.source,
    ...(target.path !== undefined ? { path: target.path } : {}),
  }));
}

function buildAgentContext(agent: Pick<Agent, "name" | "description" | "instructions">): string {
  return [
    "Agent name: " + agent.name,
    agent.description ? "Purpose: " + agent.description : "",
    "Instructions: " + (agent.instructions || "(none given)"),
  ]
    .filter(Boolean)
    .join("\n");
}

export class InjectionScanner {
  constructor(private readonly judge: SemanticJudge) {}

  async scan(
    agent: Pick<Agent, "name" | "description" | "instructions">,
    targets: ScanTarget[],
  ): Promise<ScanVerdict> {
    const staticFindings = targets.flatMap((target) => runStaticChecks(target));

    let semanticFindings: ScanFinding[] = [];
    try {
      semanticFindings = await this.judge.classify({
        agentContext: buildAgentContext(agent),
        targets,
      });
    } catch {
      // Fail-open at the semantic tier only; static findings still apply.
      semanticFindings = [];
    }

    const findings = [...staticFindings, ...semanticFindings];
    const blocked = findings.some((item) => item.severity === "malicious");
    return { blocked, findings, scannedAt: new Date().toISOString() };
  }
}

export { buildAgentContext, detectEncodedContent, detectFakeSystemMessage, detectInstructionPatterns, detectInvisibleOrHomoglyphChars };

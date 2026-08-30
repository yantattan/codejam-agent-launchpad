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

function looksLikeHeaderLine(line: string): boolean {
  return (
    FAKE_HEADER_KEYWORDS.test(line.toUpperCase()) ||
    (/^[A-Z][A-Z0-9 _-]{3,}$/.test(line) && line === line.toUpperCase())
  );
}

function detectFakeSystemMessage(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]?.trim() ?? "";
    if (!line || !looksLikeHeaderLine(line)) {
      i++;
      continue;
    }

    // A fake system-message block is usually several header-like lines in
    // a row ("SYSTEM CONFIGURATION" / "Priority: Critical" / ...) — consume
    // the whole run as one block instead of flagging each line on its own.
    let end = i + 1;
    while (end < lines.length) {
      const candidate = lines[end]?.trim() ?? "";
      if (!candidate || !looksLikeHeaderLine(candidate)) break;
      end++;
    }

    const blockLines = lines.slice(i, end);
    const windowText = lines.slice(i, end + 5).join(" ");
    const hasImperative = IMPERATIVE_NEARBY.test(windowText);
    const index = text.indexOf(blockLines[0] ?? "");
    findings.push(
      finding({
        severity: hasImperative ? "malicious" : "suspicious",
        technique: "fake-system-message",
        source: "prompt",
        excerpt: excerptAround(text, index === -1 ? 0 : index, blockLines.join(" ").length),
        detail: hasImperative
          ? "Content mimics a system/developer message and pairs it with an imperative directive — this text has no real authority over the Agent."
          : "Content mimics a system/developer-style header. Treated as data, not as authoritative.",
      }),
    );
    i = end;
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

// --- Self-declared conclusions: text trying to dictate the evaluator's
// decision directly, rather than just describing qualifications ---

const SELF_DECLARATION_PATTERNS: RegExp[] = [
  /\b(select|choose|hire|pick|approve|advance)\s+(me|this\s+candidate|this\s+application|this\s+resume)\b/i,
  /\bi\s+am\s+(clearly|definitely|obviously|undoubtedly)?\s*(the\s+)?(best|ideal|perfect|top|number\s*one|#\s*1)\s+(candidate|fit|choice|applicant)\b/i,
  /\brank\s+(me|this\s+candidate|this\s+resume)\s+(first|#?\s*1|highest)\b/i,
  /\bno\s+other\s+candidate\s+(compares|is\s+as\s+qualified|comes\s+close)\b/i,
  /\bmove\s+(me|this\s+candidate)\s+(forward|to\s+the\s+next\s+(stage|round))\b/i,
];

function detectSelfDeclaredConclusion(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const regex of SELF_DECLARATION_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      findings.push(
        finding({
          severity: "malicious",
          technique: "self-declared-conclusion",
          source: "prompt",
          excerpt: excerptAround(text, match.index, match[0].length),
          detail:
            "Document tries to directly dictate the evaluator's decision (who to select/rank/approve) rather than describing qualifications for a human or Agent to judge.",
        }),
      );
    }
  }
  return findings;
}

// --- Exaggerated / superlative-heavy language: a density heuristic, not a
// single-keyword match, since normal enthusiastic writing uses these words
// occasionally too ---

const SUPERLATIVE_WORDS = [
  "best",
  "unparalleled",
  "unmatched",
  "unrivaled",
  "world-class",
  "world class",
  "perfect",
  "flawless",
  "exceptional",
  "phenomenal",
  "extraordinary",
  "unbeatable",
  "greatest",
  "number one",
  "incomparable",
  "peerless",
  "unstoppable",
  "the ideal candidate",
];

function detectExaggeratedClaims(text: string): ScanFinding[] {
  const lower = text.toLowerCase();
  const wordCount = Math.max(1, text.trim().split(/\s+/).length);
  let hits = 0;
  const matched: string[] = [];
  for (const phrase of SUPERLATIVE_WORDS) {
    const count = lower.split(phrase).length - 1;
    if (count > 0) {
      hits += count;
      matched.push(phrase);
    }
  }
  // An absolute-count gate (>=3 distinct superlatives) matters regardless
  // of document length; a density gate only makes sense once there's
  // enough text for the ratio to mean anything — otherwise one incidental
  // "best" in a short sentence would trip it.
  const dense = wordCount >= 50 && hits / wordCount > 0.02;
  if (hits < 3 && !dense) return [];
  return [
    finding({
      severity: "suspicious",
      technique: "exaggerated-language",
      source: "prompt",
      excerpt: matched.slice(0, 6).join(", "),
      detail:
        "Unusually dense superlative/absolute language (" +
        hits +
        " instances: " +
        matched.slice(0, 6).join(", ") +
        ") — a pattern used to game automated scoring rather than describe genuine qualifications. Density alone isn't proof; treat as a lower-confidence signal.",
    }),
  ];
}

// --- Hidden-via-styling: text that's structurally present and readable by
// an Agent parsing raw content, but invisible to a human looking at it
// rendered — color matching the background, zero font size, off-screen
// positioning, etc. This is a distinct mechanism from the zero-width
// Unicode tricks above: the characters themselves are perfectly normal,
// only the *styling* hides them. ---

function extractStyleBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/style\s*=\s*["']([^"']*)["']/gi)) {
    if (match[1]) blocks.push(match[1]);
  }
  for (const styleTag of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const body = styleTag[1] ?? "";
    for (const rule of body.matchAll(/\{([^}]*)\}/g)) {
      if (rule[1]) blocks.push(rule[1]);
    }
  }
  return blocks;
}

function parseDeclarations(block: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const decl of block.split(";")) {
    const colonIndex = decl.indexOf(":");
    if (colonIndex === -1) continue;
    const prop = decl.slice(0, colonIndex).trim().toLowerCase();
    const value = decl.slice(colonIndex + 1).trim().toLowerCase();
    if (prop) props[prop] = value;
  }
  return props;
}

const NAMED_COLOR_HEX: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  snow: "#fffafa",
  ivory: "#fffff0",
};

function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  if (NAMED_COLOR_HEX[v]) return NAMED_COLOR_HEX[v];
  const hexShort = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (hexShort && hexShort[1] && hexShort[2] && hexShort[3]) {
    return "#" + hexShort[1] + hexShort[1] + hexShort[2] + hexShort[2] + hexShort[3] + hexShort[3];
  }
  return v;
}

const OFFSCREEN_OFFSET = /-(\d{3,})(px|em|rem|%)/;
const ZERO_ISH_FONT_SIZE = /^0(\.0*)?(px|pt|em|rem|%)?$/;

// A single hidden sentence is often marked up as many small elements (one
// per word, sometimes one per letter — either a document-generator quirk
// or a deliberate attempt to dodge whole-phrase matching). Each element
// still triggers its own style-hiding condition, so hits are collected
// with position first and coalesced afterward — adjacent same-technique
// hits become one finding instead of one per element.
interface StyleHit {
  index: number;
  end: number;
  severity: ScanSeverity;
  technique: string;
  detail: string;
}

const STYLE_HIT_MERGE_GAP = 300;

function coalesceStyleHits(text: string, hits: StyleHit[]): ScanFinding[] {
  const sorted = [...hits].sort((left, right) => left.index - right.index);
  const findings: ScanFinding[] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    if (!first) break;
    let end = first.end;
    let j = i + 1;
    while (true) {
      const next = sorted[j];
      if (!next || next.technique !== first.technique || next.index - end > STYLE_HIT_MERGE_GAP) break;
      end = Math.max(end, next.end);
      j++;
    }
    const mergedCount = j - i;
    findings.push(
      finding({
        severity: first.severity,
        technique: first.technique,
        source: "prompt",
        excerpt: excerptAround(text, first.index, end - first.index),
        detail: mergedCount > 1 ? first.detail + " (" + mergedCount + " adjacent occurrences merged)" : first.detail,
      }),
    );
    i = j;
  }
  return findings;
}

function detectHiddenViaStyling(text: string): ScanFinding[] {
  const hits: StyleHit[] = [];
  let searchFrom = 0;
  for (const block of extractStyleBlocks(text)) {
    const foundAt = text.indexOf(block, searchFrom);
    const index = foundAt === -1 ? text.indexOf(block) : foundAt;
    const resolvedIndex = index === -1 ? 0 : index;
    if (index !== -1) searchFrom = index + block.length;
    const props = parseDeclarations(block);
    const push = (severity: ScanSeverity, technique: string, detail: string) =>
      hits.push({ index: resolvedIndex, end: resolvedIndex + block.length, severity, technique, detail });

    const color = props["color"];
    const background = props["background-color"] ?? props["background"];
    if (color && background) {
      const normalizedColor = normalizeColor(color);
      const normalizedBackground = normalizeColor(background);
      if (normalizedColor === normalizedBackground && normalizedColor !== "transparent") {
        push(
          "malicious",
          "hidden-text-color-match",
          "Text color is set identical to its background color (" +
            normalizedColor +
            ") — invisible to a human reader, but the content is still read and acted on by the Agent.",
        );
      }
    }

    const fontSize = props["font-size"];
    if (fontSize && ZERO_ISH_FONT_SIZE.test(fontSize.replace(/\s+/g, ""))) {
      push("malicious", "hidden-text-zero-font-size", "Text is styled at zero or near-zero font size — never renders visibly.");
    }

    const opacity = props["opacity"] !== undefined ? Number.parseFloat(props["opacity"]) : null;
    if (opacity !== null && !Number.isNaN(opacity) && opacity <= 0.05) {
      push("malicious", "hidden-text-near-zero-opacity", "Text opacity is set to " + opacity + " — effectively invisible.");
    }

    if (props["display"] === "none") {
      push("suspicious", "hidden-text-display-none", "Content is styled display:none — not rendered to a human reader. Has legitimate uses (templates, toggles), so flagged rather than blocked on its own.");
    }
    if (props["visibility"] === "hidden") {
      push("suspicious", "hidden-text-visibility-hidden", "Content is styled visibility:hidden — not rendered to a human reader.");
    }

    const offsets = ["left", "top", "margin-left", "margin-top", "text-indent"]
      .map((key) => props[key])
      .filter((value): value is string => Boolean(value));
    if (props["position"] === "absolute" && offsets.some((value) => OFFSCREEN_OFFSET.test(value))) {
      push("malicious", "hidden-text-offscreen-position", "Content is absolutely positioned far outside the visible page area — never seen by a human reader.");
    }
  }
  return coalesceStyleHits(text, hits);
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
// A document with many separate encoded tokens (e.g. several embedded
// assets) could otherwise produce one finding per token — cap it and
// summarize the rest instead of flooding the results.
const MAX_ENCODED_FINDINGS = 8;

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

  if (findings.length > MAX_ENCODED_FINDINGS) {
    const shown = findings.slice(0, MAX_ENCODED_FINDINGS);
    shown.push(
      finding({
        severity: "info",
        technique: "encoded-content-truncated",
        source,
        excerpt: "",
        detail:
          (findings.length - MAX_ENCODED_FINDINGS) +
          " additional encoded-content finding(s) omitted to avoid flooding the results.",
      }),
    );
    return shown;
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
    ...detectSelfDeclaredConclusion(target.text),
    ...detectExaggeratedClaims(target.text),
    ...detectHiddenViaStyling(target.text),
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

export {
  buildAgentContext,
  detectEncodedContent,
  detectExaggeratedClaims,
  detectFakeSystemMessage,
  detectHiddenViaStyling,
  detectInstructionPatterns,
  detectInvisibleOrHomoglyphChars,
  detectSelfDeclaredConclusion,
};

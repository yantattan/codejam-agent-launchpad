import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanFinding, ScanSeverity } from "./types.js";

export interface PdfExtraction {
  /** All extracted page text, concatenated — what an ingestion pipeline
   * using this same library family would receive. */
  text: string;
  /** Document Info dictionary fields a human reviewer never sees unless
   * they open "document properties". */
  metadata: Record<string, string>;
  /** Text from annotations/comments — invisible in most viewers until
   * explicitly clicked open. */
  annotationText: string[];
  /** Findings derived from geometry/color, not text content — these are
   * already-final ScanFindings, not raw text to re-scan. */
  visualFindings: ScanFinding[];
}

const NEAR_WHITE_THRESHOLD = 0.9; // per RGB channel, 0-1 scale
const NEAR_ZERO_FONT_SIZE_PT = 0.5;
const OFFPAGE_MARGIN_PT = 2;
const EXCERPT_MAX_LENGTH = 160;

function standardFontDataUrl(): string {
  try {
    const packageJsonUrl = import.meta.resolve("pdfjs-dist/package.json");
    const packageRoot = path.dirname(fileURLToPath(packageJsonUrl));
    // pdfjs validates this as a URL-shaped string (must end with "/"),
    // not a native path — force forward slashes even on Windows.
    return path.join(packageRoot, "standard_fonts").split(path.sep).join("/") + "/";
  } catch {
    return "";
  }
}

function toMatrixArray(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  const obj = (value ?? {}) as Record<number, number>;
  return [obj[0] ?? 1, obj[1] ?? 0, obj[2] ?? 0, obj[3] ?? 1, obj[4] ?? 0, obj[5] ?? 0];
}

function isNearWhite(rgb: number[]): boolean {
  return rgb.every((channel) => channel >= NEAR_WHITE_THRESHOLD);
}

function pdfFinding(
  severity: ScanSeverity,
  technique: string,
  sourcePath: string | undefined,
  excerpt: string,
  detail: string,
): ScanFinding {
  return {
    tier: "static",
    severity,
    technique,
    source: "workspace-file",
    ...(sourcePath !== undefined ? { path: sourcePath } : {}),
    excerpt: excerpt.slice(0, EXCERPT_MAX_LENGTH),
    detail,
  };
}

/**
 * Walks a PDF page's raw operator list — the actual drawing instructions,
 * not the pre-composed text layer a naive text extractor exposes — to
 * recover, per text run: what was drawn, at what size, what color, and
 * where on the page. This is what "text visible to the extraction pipeline
 * but not to a human" actually looks like at the format level: the
 * characters are perfectly real content, only the rendering hides them.
 */
async function extractVisualFindings(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  pdfDocument: Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]>,
  sourcePath: string | undefined,
): Promise<ScanFinding[]> {
  const findings: ScanFinding[] = [];
  const OPS = pdfjs.OPS;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const view = page.view;
    const x0 = view[0] ?? 0;
    const y0 = view[1] ?? 0;
    const x1 = view[2] ?? 0;
    const y1 = view[3] ?? 0;
    const opList = await page.getOperatorList();

    // PDF's default fill is black absent any color operator.
    let fill = [0, 0, 0];
    let fontSize = 0;
    let matrix = [1, 0, 0, 1, 0, 0];

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] as unknown[];

      if (fn === OPS.setFillRGBColor) {
        const hex = String(args[0]).replace("#", "");
        fill = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
      } else if (fn === OPS.setFillGray) {
        const gray = Number(args[0]);
        fill = [gray, gray, gray];
      } else if (fn === OPS.setFont) {
        fontSize = Number(args[1]) || 0;
      } else if (fn === OPS.setTextMatrix) {
        matrix = toMatrixArray(args[0]);
      } else if (fn === OPS.showText) {
        const glyphs = args[0] as { unicode?: string; fontChar?: string }[];
        const text = glyphs
          .map((glyph) => glyph.unicode ?? glyph.fontChar ?? "")
          .join("")
          .trim();
        if (!text) continue;

        const [posX, posY] = [matrix[4] ?? 0, matrix[5] ?? 0];
        const label = "\"" + text + "\" (page " + pageNumber + ")";

        if (fontSize > 0 && fontSize < NEAR_ZERO_FONT_SIZE_PT) {
          findings.push(
            pdfFinding(
              "malicious",
              "pdf-hidden-zero-font-size",
              sourcePath,
              label,
              "Text is rendered at " +
                fontSize.toFixed(2) +
                "pt — invisible at any normal zoom level, but present in the extracted text a document-ingestion pipeline would receive.",
            ),
          );
        }
        if (isNearWhite(fill)) {
          findings.push(
            pdfFinding(
              "malicious",
              "pdf-hidden-color-match",
              sourcePath,
              label,
              "Text fill color is near-white — invisible against a normal white page, but present in the extracted text.",
            ),
          );
        }
        if (posX < x0 - OFFPAGE_MARGIN_PT || posX > x1 + OFFPAGE_MARGIN_PT || posY < y0 - OFFPAGE_MARGIN_PT || posY > y1 + OFFPAGE_MARGIN_PT) {
          findings.push(
            pdfFinding(
              "malicious",
              "pdf-hidden-offscreen-position",
              sourcePath,
              label,
              "Text is positioned outside the visible page area (page bounds " +
                [x0, y0, x1, y1].map((v) => Math.round(v)).join(",") +
                ") — never rendered where a human would look.",
            ),
          );
        }
      }
    }
    page.cleanup();
  }
  return findings;
}

/**
 * Parses a PDF directly with the same library family a naive ingestion
 * pipeline would use — deliberately, so the middleware sees exactly what
 * the Agent's own extraction is likely to see, rather than trusting the
 * rendered page. Returns text/metadata/annotations as scan-able text plus
 * already-resolved geometric findings. Never throws — a corrupt/encrypted
 * PDF becomes an "unparseable" finding rather than crashing the run.
 */
export async function scanPdfBuffer(buffer: Buffer, sourcePath?: string): Promise<PdfExtraction> {
  const empty: PdfExtraction = { text: "", metadata: {}, annotationText: [], visualFindings: [] };
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return empty;
  }

  let pdfDocument;
  let loadingTask: ReturnType<typeof pdfjs.getDocument>;
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: standardFontDataUrl(),
      useSystemFonts: true,
    });
    pdfDocument = await loadingTask.promise;
  } catch (err) {
    if (process.env["PDF_SCANNER_DEBUG"]) {
      console.error("pdf-scanner load error:", err);
    }
    return {
      ...empty,
      visualFindings: [
        pdfFinding(
          "suspicious",
          "pdf-unparseable",
          sourcePath,
          "(could not parse)",
          "This PDF could not be parsed for security scanning (corrupt, encrypted, or malformed) — treat with caution since its contents were never inspected.",
        ),
      ],
    };
  }

  try {
    const metadata: Record<string, string> = {};
    try {
      const metadataResult = await pdfDocument.getMetadata();
      const info = (metadataResult.info ?? {}) as Record<string, unknown>;
      for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]) {
        const value = info[key];
        if (typeof value === "string" && value.trim()) metadata[key] = value.trim();
      }
      const xmp = metadataResult.metadata;
      if (xmp) {
        const raw = xmp.getRaw?.() ?? "";
        if (typeof raw === "string" && raw.trim()) metadata["XMP"] = raw.trim();
      }
    } catch {
      // Metadata is a bonus signal, not required for the scan to proceed.
    }

    let text = "";
    const annotationText: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + "\n";

      try {
        const annotations = await page.getAnnotations({ intent: "display" });
        for (const annotation of annotations) {
          const contents = (annotation as { contents?: string }).contents;
          if (contents && contents.trim()) annotationText.push(contents.trim());
        }
      } catch {
        // Annotations are a bonus signal too.
      }
      page.cleanup();
    }

    const visualFindings = await extractVisualFindings(pdfjs, pdfDocument, sourcePath);
    return { text: text.trim(), metadata, annotationText, visualFindings };
  } finally {
    await loadingTask.destroy();
  }
}

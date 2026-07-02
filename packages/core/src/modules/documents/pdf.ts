/**
 * Minimal dependency-free PDF writer (issue #47).
 *
 * Emits PDF 1.4 with Helvetica / Helvetica-Bold (built-in base-14 fonts, no
 * embedding) and uncompressed content streams. Pure string/Uint8Array work —
 * no Node-only APIs, so it runs on Cloudflare Workers and other serverless
 * runtimes. Enough for text documents like invoices; not a general renderer.
 */

export interface PdfTextOp {
  x: number;
  y: number;
  size: number;
  bold?: boolean | undefined;
  text: string;
}

/** A4 in PDF points. */
export const A4 = { width: 595.28, height: 841.89 } as const;

// Escape to a PDF literal string: backslash, parens, and non-ASCII bytes as
// octal escapes (Latin-1 / WinAnsi range; anything beyond becomes "?").
function escapePdfText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code > 126 && code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
}

function contentStream(ops: PdfTextOp[]): string {
  const parts: string[] = [];
  for (const op of ops) {
    const font = op.bold ? "/F2" : "/F1";
    parts.push(
      `BT ${font} ${op.size} Tf ${op.x.toFixed(2)} ${op.y.toFixed(2)} Td (${escapePdfText(op.text)}) Tj ET`,
    );
  }
  return parts.join("\n");
}

/**
 * Builds a complete PDF document; one inner array of text ops per page.
 */
export function buildPdf(pages: PdfTextOp[][]): Uint8Array {
  // Object numbering: 1 Catalog, 2 Pages, 3 F1, 4 F2, then per page: Page, Contents.
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const firstPageObj = 5;

  for (let i = 0; i < pages.length; i++) {
    pageObjectNumbers.push(firstPageObj + i * 2);
  }

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`);

  for (let i = 0; i < pages.length; i++) {
    const pageNum = pageObjectNumbers[i]!;
    const contentNum = pageNum + 1;
    const stream = contentStream(pages[i]!);
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  const header = "%PDF-1.4\n";
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefOffset = body.length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const full = body + xref + trailer;
  // All bytes are ASCII/Latin-1 by construction (escapePdfText), so a
  // byte-per-char encoding is exact.
  const bytes = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i++) bytes[i] = full.charCodeAt(i) & 0xff;
  return bytes;
}

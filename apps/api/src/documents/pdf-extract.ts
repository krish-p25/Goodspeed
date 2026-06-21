import pdfParse from 'pdf-parse'

/**
 * Shape of an uploaded file as populated by Multer (via FileInterceptor).
 * Declared locally so we don't depend on the global Express.Multer namespace.
 */
export interface UploadedPdf {
  buffer: Buffer
  mimetype: string
  originalname: string
  size: number
}

/**
 * Extract text from a PDF buffer and normalize it into markdown-friendly prose.
 *
 * Extraction runs server-side (Node) so the browser bundle stays free of
 * pdfjs — which does not bundle cleanly under Turbopack. PDFs carry no real
 * structure, so headings/lists are not recovered; the goal is clean, readable
 * paragraphs ready to edit in the markdown editor.
 */
export async function extractPdfMarkdown(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer)
  return normalizePdfText(data.text ?? '')
}

export function normalizePdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    // Join words hyphenated across a line break: "exam-\nple" -> "example"
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    // Trim whitespace hugging line breaks
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    // Collapse runs of blank lines and spaces
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

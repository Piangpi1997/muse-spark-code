/** A small, valid blank PDF with a page tree for file-input tests (M54). */
export function pdfFixture(
  pages: number,
  pageTreeExtra = '',
  options?: {
    readonly pageTreeType?: string
    readonly countName?: string
    readonly typeGap?: string
    readonly countGap?: string
    readonly withDecoy?: boolean
  },
): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type ${options?.typeGap ?? ''}/${options?.pageTreeType ?? 'Pages'} ${pageTreeExtra} /Kids [${Array.from({ length: pages }, (_, index) => `${String(index + 3)} 0 R`).join(' ')}] /${options?.countName ?? 'Count'} ${options?.countGap ?? ''}${String(pages)} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>'),
    ...(options?.withDecoy === true ? ['<< /Type /Pages /Kids [] /Count 1 >>'] : []),
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, body] of objects.entries()) {
    offsets.push(source.length)
    source += `${String(index + 1)} 0 obj\n${body}\nendobj\n`
  }
  const xref = source.length
  source += `xref\n0 ${String(offsets.length)}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  source += `trailer\n<< /Size ${String(offsets.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return new TextEncoder().encode(source)
}

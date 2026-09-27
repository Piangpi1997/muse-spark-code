import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPdf, pdfPageCount } from '../../src/core/pdf'
import { PDF_PAGE_TREE_SCAN_LIMIT } from '../../src/shared/constants'
import { pdfFixture } from './helpers/pdfFixture'

describe('PDF input inspection', () => {
  it('recognises a PDF by bytes, not a name, and reads the page tree', () => {
    const bytes = pdfFixture(4)
    expect(isPdf(bytes)).toBe(true)
    expect(pdfPageCount(bytes)).toBe(4)
    expect(isPdf(new TextEncoder().encode('report.pdf'))).toBe(false)
  })

  it('leaves the page count unknown for a header with no readable page tree', () => {
    expect(pdfPageCount(new TextEncoder().encode('%PDF-1.4\nopaque'))).toBeUndefined()
  })

  it('reserves the full budget when the real page tree is compressed and a visible one is unlinked', () => {
    // Valid 50-page PDF: pypdf strict reader verifies the compressed Pages object.
    const bytes = readFileSync(
      new URL('../fixtures/compressed-pages-unlinked.pdf', import.meta.url),
    )
    expect(isPdf(bytes)).toBe(true)
    expect(pdfPageCount(bytes)).toBeUndefined()
  })

  it('recognises a PDF name escape on a compressed page tree', () => {
    const bytes = readFileSync(
      new URL('../fixtures/compressed-pages-unlinked.pdf', import.meta.url),
    )
    const source = bytes.toString('latin1')
    const escaped = source.replace('<< /Type /ObjStm /N', '<</Type /Obj#53tm/N')
    expect(escaped).not.toBe(source)
    // Same byte length keeps this fixture's cross-reference offsets valid.
    expect(Buffer.byteLength(escaped, 'latin1')).toBe(bytes.byteLength)
    expect(pdfPageCount(Buffer.from(escaped, 'latin1'))).toBeUndefined()
  })

  it('reserves the full budget for an escaped encryption name', () => {
    expect(pdfPageCount(pdfFixture(1, '/Review /Encr#79pt'))).toBeUndefined()
  })

  it.each([{ pageTreeType: 'Pag#65s' }, { countName: 'Co#75nt' }])(
    'does not trust a visible decoy count beside an escaped page-tree name: %o',
    (options) => {
      expect(pdfPageCount(pdfFixture(50, '', { ...options, withDecoy: true }))).toBeUndefined()
    },
  )

  it.each([{ typeGap: '% a page-tree comment\n' }, { countGap: '% a count comment\n' }])(
    'does not trust a decoy count when comments hide the real tree: %o',
    (options) => {
      expect(pdfPageCount(pdfFixture(50, '', { ...options, withDecoy: true }))).toBeUndefined()
    },
  )

  it.each(['<< /Type /Pages /Kids [] >>', '<< /Type /Pages /Count 100001 >>'])(
    'does not use a decoy count beside an ambiguous visible page tree: %s',
    (extra) => {
      const bytes = new TextEncoder().encode(`%PDF-1.4\n${extra}\n<< /Type /Pages /Count 1 >>\n`)
      expect(pdfPageCount(bytes)).toBeUndefined()
    },
  )

  it('reserves the full budget when page-tree marker volume exceeds the bounded inspector', () => {
    const bytes = new TextEncoder().encode(
      `%PDF-1.4\n${'<< /Type /Pages /Count 1 >>\n'.repeat(PDF_PAGE_TREE_SCAN_LIMIT + 1)}`,
    )
    expect(pdfPageCount(bytes)).toBeUndefined()
  })

  it.each([
    '/Custom << /Count 1 >>',
    '/Custom [/Count 1]',
    '/Custom (note /Count 1)',
    '/Custom 0 % /Count 1\n',
  ])('uses the page tree direct count despite an earlier %s', (extra) => {
    expect(pdfPageCount(pdfFixture(50, extra))).toBe(50)
  })
})

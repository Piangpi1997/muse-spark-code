import { describe, expect, it } from 'vitest'
import { isPdf, pdfPageCount } from '../../src/core/pdf'
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

  it.each([
    '/Custom << /Count 1 >>',
    '/Custom [/Count 1]',
    '/Custom (note /Count 1)',
    '/Custom 0 % /Count 1\n',
  ])('uses the page tree direct count despite an earlier %s', (extra) => {
    expect(pdfPageCount(pdfFixture(50, extra))).toBe(50)
  })
})

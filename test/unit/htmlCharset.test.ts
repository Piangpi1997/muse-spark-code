import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeHtml } from '../../src/core/web/htmlCharset'

// 0xE9 is "é" in windows-1252 and ISO-8859-2; 0xB1 is "±" in windows-1252, "ą" in ISO-8859-2.
const E9 = 0xe9
const B1 = 0xb1
const EURO_1252 = 0x80

function page(head: string, body: readonly number[]): Uint8Array {
  return new Uint8Array([...Buffer.from(head, 'latin1'), ...body])
}

describe("an HTML page's encoding, sniffed as HTML does (M69)", () => {
  it('reads a <meta charset> and a <meta http-equiv> content charset', () => {
    expect(decodeHtml(page('<meta charset="windows-1252">', [E9, EURO_1252]), undefined)).toBe(
      '<meta charset="windows-1252">é€',
    )
    expect(
      decodeHtml(
        page('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2">', [B1]),
        undefined,
      ).endsWith('ą'),
    ).toBe(true)
  })

  it('ignores a charset in a comment, or in an attribute that is not the declaration', () => {
    const commented = page('<!-- <meta charset="iso-8859-2"> --><meta charset="windows-1252">', [
      B1,
    ])
    expect(decodeHtml(commented, undefined).endsWith('±')).toBe(true)
    // `content` counts only with http-equiv="content-type".
    const otherAttribute = page('<meta name="x" content="text/html; charset=iso-8859-2">', [E9])
    expect(decodeHtml(otherAttribute, undefined).endsWith('\u{FFFD}')).toBe(true)
    const inText = page('<p>charset=iso-8859-2</p>', [E9])
    expect(decodeHtml(inText, undefined).endsWith('\u{FFFD}')).toBe(true)
  })

  it('lets a byte order mark, then the header, win over the markup', () => {
    const declared = page('<meta charset="iso-8859-2">', [B1])
    expect(decodeHtml(declared, 'windows-1252').endsWith('±')).toBe(true)
    expect(decodeHtml(declared, undefined).endsWith('ą')).toBe(true)
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('<p>é</p>', 'utf8')])
    expect(decodeHtml(withBom, 'windows-1252')).toBe('<p>é</p>')
  })

  it('reads a page that declares nothing, or an unknown label, as UTF-8', () => {
    expect(decodeHtml(new Uint8Array(Buffer.from('<p>é</p>', 'utf8')), undefined)).toBe('<p>é</p>')
    expect(decodeHtml(new Uint8Array(Buffer.from('<p>é</p>', 'utf8')), 'no-such-label')).toBe(
      '<p>é</p>',
    )
  })
})

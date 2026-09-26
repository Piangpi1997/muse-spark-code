import { describe, expect, it } from 'vitest'
import { AttachmentStore } from '../../src/core/attachments'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  UI_TEXT,
} from '../../src/shared/constants'
import { pdfFixture } from './helpers/pdfFixture'

const dimension = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

function png(width: number, height: number, padding = 0): Uint8Array {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]
  return Uint8Array.from([
    ...header,
    ...dimension(width),
    ...dimension(height),
    ...Array.from({ length: padding }, () => 0),
  ])
}

function store(maxEncodedMediaChars?: number) {
  let next = 0
  return new AttachmentStore(() => {
    next += 1
    return `att-${String(next)}`
  }, maxEncodedMediaChars)
}

describe('AttachmentStore', () => {
  it('accepts a supported image and reports its size', () => {
    const attachments = store()
    const result = attachments.add('shot.png', png(686, 695))
    expect(result).toEqual({
      ok: true,
      attachment: {
        id: 'att-1',
        name: 'shot.png',
        mediaType: 'image/png',
        width: 686,
        height: 695,
        sizeBytes: 24,
      },
    })
    expect(attachments.size).toBe(1)
    expect(attachments.list()).toHaveLength(1)
  })

  it('refuses unsupported bytes, oversized images and too many images', () => {
    const attachments = store()
    expect(attachments.add('doc.pdf', Uint8Array.from([1, 2, 3]))).toMatchObject({
      ok: false,
      reason: UI_TEXT.invalidPdf,
    })
    expect(attachments.add('huge.png', png(1, 1, MAX_IMAGE_BYTES))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('10 MB'),
    })
    for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE; index += 1) {
      expect(attachments.add(`${String(index)}.png`, png(1, 1)).ok).toBe(true)
    }
    expect(attachments.add('one-too-many.png', png(1, 1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('At most'),
    })
  })

  it('accepts a PDF on Model API, preserves its name and bytes, and refuses it on Muse Code', () => {
    const bytes = pdfFixture(3)
    const attachments = store()
    expect(attachments.add('report.pdf', bytes)).toEqual({
      ok: false,
      reason: UI_TEXT.pdfNeedsModelApi,
    })
    expect(attachments.add('report.pdf', bytes, true)).toEqual({
      ok: true,
      attachment: {
        id: 'att-1',
        name: 'report.pdf',
        mediaType: 'application/pdf',
        sizeBytes: bytes.length,
        pageCount: 3,
      },
    })
    expect(attachments.partsFor(['att-1'])).toEqual([
      {
        type: 'file',
        name: 'report.pdf',
        mediaType: 'application/pdf',
        base64Data: Buffer.from(bytes).toString('base64'),
        sizeBytes: bytes.length,
        pageCount: 3,
      },
    ])
  })

  it('counts PDF pages with images and refuses an oversized or uncountable second PDF', () => {
    const attachments = store()
    expect(attachments.add('first.pdf', pdfFixture(49), true).ok).toBe(true)
    expect(attachments.add('a.png', png(1, 1), true).ok).toBe(true)
    expect(attachments.add('b.png', png(1, 1), true)).toEqual({
      ok: false,
      reason: UI_TEXT.documentsOverBudget,
    })
    const oversized = new Uint8Array(MAX_DOCUMENT_BYTES + 1)
    oversized.set(new TextEncoder().encode('%PDF-1.4'))
    expect(attachments.add('big.pdf', oversized, true)).toEqual({
      ok: false,
      reason: UI_TEXT.documentTooLarge,
    })
    attachments.clear()
    expect(attachments.add('unknown.pdf', new TextEncoder().encode('%PDF-1.4'), true).ok).toBe(true)
    expect(attachments.add('another.png', png(1, 1), true)).toEqual({
      ok: false,
      reason: UI_TEXT.documentsOverBudget,
    })
  })

  it('does not under-reserve image slots from a nested PDF dictionary count', () => {
    const attachments = store()
    expect(
      attachments.add('nested.pdf', pdfFixture(50, '/Custom << /Count 1 >>'), true),
    ).toMatchObject({
      ok: true,
      attachment: { pageCount: 50 },
    })
    expect(attachments.add('extra.png', png(1, 1), true)).toEqual({
      ok: false,
      reason: UI_TEXT.documentsOverBudget,
    })
  })

  it('refuses combined encoded media above the message cap before retaining it', () => {
    const bytes = pdfFixture(1)
    const encodedLength = `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`
      .length
    const attachments = store(encodedLength + 1)
    expect(attachments.add('first.pdf', bytes, true).ok).toBe(true)
    expect(attachments.add('second.pdf', bytes, true)).toEqual({
      ok: false,
      reason: UI_TEXT.mediaTotalTooLarge,
    })
    expect(attachments.list()).toHaveLength(1)
    attachments.clear()
    expect(attachments.add('second.pdf', bytes, true).ok).toBe(true)
  })

  it('accepts bounded UTF-8 text as a named part, not as a guessed binary file', () => {
    const attachments = store()
    const bytes = new TextEncoder().encode('first line\nsecond line')
    expect(attachments.add('notes.md', bytes, false, true)).toMatchObject({
      ok: true,
      attachment: { name: 'notes.md', mediaType: 'text/plain' },
    })
    expect(attachments.partsFor(['att-1'])).toEqual([
      {
        type: 'textFile',
        name: 'notes.md',
        mediaType: 'text/plain',
        sizeBytes: bytes.length,
        text: 'first line\nsecond line',
      },
    ])
    expect(attachments.add('invalid.txt', Uint8Array.from([0xff]), false, true)).toEqual({
      ok: false,
      reason: UI_TEXT.textFileInvalid,
    })
    expect(attachments.add('binary.json', Uint8Array.from([0]), false, true)).toEqual({
      ok: false,
      reason: UI_TEXT.textFileInvalid,
    })
    expect(
      attachments.add('huge.txt', new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1), false, true),
    ).toEqual({ ok: false, reason: UI_TEXT.textFileTooLarge })
  })

  it('builds base64 image parts for the requested ids and drops them once released', () => {
    const attachments = store()
    attachments.add('a.png', png(2, 3))
    attachments.add('b.png', png(4, 5))
    attachments.add('c.png', png(6, 7))
    const parts = attachments.partsFor(['att-3', 'missing', 'att-1'])
    // Kept until the message is accepted (D26): a refused send tries again with them.
    expect(attachments.size).toBe(3)
    attachments.release(['att-3', 'missing', 'att-1'])
    expect(parts).toEqual([
      {
        type: 'image',
        base64Data: Buffer.from(png(6, 7)).toString('base64'),
        mediaType: 'image/png',
        width: 6,
        height: 7,
      },
      {
        type: 'image',
        base64Data: Buffer.from(png(2, 3)).toString('base64'),
        mediaType: 'image/png',
        width: 2,
        height: 3,
      },
    ])
    expect(attachments.list().map((entry) => entry.id)).toEqual(['att-2'])
  })

  it('removes and clears', () => {
    const attachments = store()
    attachments.add('a.png', png(1, 1))
    attachments.add('b.png', png(1, 1))
    expect(attachments.remove('att-1')).toBe(true)
    expect(attachments.remove('att-1')).toBe(false)
    attachments.clear()
    expect(attachments.size).toBe(0)
  })
})

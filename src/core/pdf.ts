// What the extension reads of a PDF (M54, PLAN.md D47): that it is one, by
// its header rather than its name, and how many pages it has when that is
// cheap to learn. The count names the chip and weighs the PDF against
// Meta's 50 images per request (its first 50 pages each become one); an
// unknown count reserves all 50 slots in the attachment store.
//
// The count comes from a directly visible `/Type /Pages` dictionary's
// `/Count`, the largest of them. Compressed or encrypted page trees have no
// count here and reserve the full request budget. This inspection never
// decompresses untrusted file content on the extension host thread.

import { Buffer } from 'node:buffer'
import {
  PDF_DICTIONARY_SCAN_CHARS,
  PDF_HEADER_WINDOW_BYTES,
  PDF_PAGE_COUNT_MAX,
  PDF_PAGE_TREE_SCAN_LIMIT,
} from '../shared/constants'

const PDF_HEADER = '%PDF-'
const PDF_NAME_ESCAPE_RADIX = 16
const PDF_NAME_ESCAPE_SOURCE_CHARS = 3
const PDF_CRITICAL_NAME_MAX_LENGTH = 'Encrypt'.length
const PDF_CRITICAL_NAME_SOURCE_MAX_LENGTH =
  PDF_CRITICAL_NAME_MAX_LENGTH * PDF_NAME_ESCAPE_SOURCE_CHARS
const PDF_CRITICAL_NAMES = new Set(['type', 'objstm', 'encrypt', 'pages', 'count'])
const PDF_NAME_HEX_PAIR = /^[0-9A-Fa-f]{2}$/
const PDF_NAME_LETTER = /^[A-Za-z]$/
const PDF_NAME_CONTINUATION = /^[A-Za-z0-9#]$/
const OBJECT_STREAM_MARKER = '/ObjStm'
const ENCRYPTION_MARKER = '/Encrypt'
const DICTIONARY_OPEN = '<<'
const DICTIONARY_CLOSE = '>>'
// A name ends where a regular character does not follow (PDF names are
// letters, digits and a few marks; the next token starts with a delimiter).
const PAGES_TYPE = /\/Type\s*\/Pages(?![A-Za-z0-9])/g
// A signed object number may name the real Pages tree while a visible direct
// tree is an unlinked decoy. Fail closed rather than trusting the decoy.
const INDIRECT_TYPE_CANDIDATE = /\/Type\s+[+-]?\d+(?![A-Za-z0-9])/
const COUNT_VALUE = /^\s+(\d+)(?![A-Za-z0-9])/
const PDF_COMMENT_CANDIDATE = /\/(?:Type|Count)/g
const PDF_WHITESPACE = ' \t\r\n\f\0'

/** A bounded parse of a PDF name that may encode one or more bytes as `#HH`. */
function escapedNameAt(text: string, slash: number): string | undefined {
  let cursor = slash + 1
  let name = ''
  let hasEscape = false
  while (name.length <= PDF_CRITICAL_NAME_MAX_LENGTH) {
    const character = text[cursor]
    if (character === '#') {
      const hex = text.slice(cursor + 1, cursor + PDF_NAME_ESCAPE_SOURCE_CHARS)
      if (!PDF_NAME_HEX_PAIR.test(hex)) {
        return undefined
      }
      name += String.fromCodePoint(Number.parseInt(hex, PDF_NAME_ESCAPE_RADIX))
      cursor += PDF_NAME_ESCAPE_SOURCE_CHARS
      hasEscape = true
    } else if (character !== undefined && PDF_NAME_LETTER.test(character)) {
      name += character
      cursor += 1
    } else {
      break
    }
  }
  return hasEscape &&
    !PDF_NAME_CONTINUATION.test(text[cursor] ?? '') &&
    PDF_CRITICAL_NAMES.has(name.toLowerCase())
    ? name
    : undefined
}

/** Too many `#` bytes are ambiguous too; inspection work stays bounded. */
function hasEscapedCriticalName(text: string): boolean {
  let inspected = 0
  for (let hash = text.indexOf('#'); hash !== -1; hash = text.indexOf('#', hash + 1)) {
    inspected += 1
    if (inspected > PDF_PAGE_TREE_SCAN_LIMIT) {
      return true
    }
    const floor = Math.max(0, hash - PDF_CRITICAL_NAME_SOURCE_MAX_LENGTH)
    const before = text.slice(floor, hash)
    const relativeSlash = before.lastIndexOf('/')
    if (relativeSlash !== -1 && escapedNameAt(text, floor + relativeSlash) !== undefined) {
      return true
    }
  }
  return false
}

/** A comment or excessive whitespace after a critical name may hide the real tree. */
function hasAmbiguousCommentGap(text: string): boolean {
  let inspected = 0
  for (const match of text.matchAll(PDF_COMMENT_CANDIDATE)) {
    inspected += 1
    if (inspected > PDF_PAGE_TREE_SCAN_LIMIT) {
      return true
    }
    let cursor = match.index + match[0].length
    let character = text[cursor]
    while (
      character !== undefined &&
      PDF_WHITESPACE.includes(character) &&
      cursor - match.index < PDF_DICTIONARY_SCAN_CHARS
    ) {
      cursor += 1
      character = text[cursor]
    }
    if (character === '%' || cursor - match.index >= PDF_DICTIONARY_SCAN_CHARS) {
      return true
    }
  }
  return false
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}

/** Whether the bytes are a PDF: its header within the first 1024 bytes. */
export function isPdf(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, PDF_HEADER_WINDOW_BYTES)).includes(PDF_HEADER)
}

/** Where the dictionary around `index` opens, looking back at most the scan window. */
function dictionaryStart(text: string, index: number): number | undefined {
  const floor = Math.max(index - PDF_DICTIONARY_SCAN_CHARS, 0)
  let depth = 0
  let at = index - DICTIONARY_OPEN.length
  while (at >= floor) {
    if (text.startsWith(DICTIONARY_CLOSE, at)) {
      depth += 1
      // A delimiter pair is two characters: the next one ends before it.
      at -= DICTIONARY_CLOSE.length
    } else if (text.startsWith(DICTIONARY_OPEN, at)) {
      if (depth === 0) {
        return at
      }
      depth -= 1
      at -= DICTIONARY_OPEN.length
    } else {
      at -= 1
    }
  }
  return undefined
}

/** Where the dictionary opening at `start` closes (just past its `>>`), within the scan window. */
function dictionaryEnd(text: string, start: number): number | undefined {
  const ceiling = Math.min(start + PDF_DICTIONARY_SCAN_CHARS, text.length)
  let depth = 0
  let at = start
  while (at < ceiling) {
    if (text.startsWith(DICTIONARY_OPEN, at)) {
      depth += 1
      at += DICTIONARY_OPEN.length
    } else if (text.startsWith(DICTIONARY_CLOSE, at)) {
      depth -= 1
      at += DICTIONARY_CLOSE.length
      if (depth === 0) {
        return at
      }
    } else {
      at += 1
    }
  }
  return undefined
}

/** The dictionary that holds `index`, with where it ends; undefined when none is found. */
function enclosingDictionary(
  text: string,
  index: number,
): { readonly body: string; readonly end: number } | undefined {
  const start = dictionaryStart(text, index)
  const end = start === undefined ? undefined : dictionaryEnd(text, start)
  return start === undefined || end === undefined
    ? undefined
    : { body: text.slice(start, end), end }
}

/** Just past a literal string, including nested parentheses and escapes. */
function afterString(body: string, start: number): number {
  let depth = 1
  let at = start + 1
  while (at < body.length && depth > 0) {
    if (body[at] === '\\') {
      at += 2
      continue
    }
    if (body[at] === '(') {
      depth += 1
      at += 1
      continue
    }
    if (body[at] === ')') {
      depth -= 1
      at += 1
      continue
    }
    at += 1
  }
  return at
}

/** A `/Count` at this dictionary's own depth, not one in a nested value. */
function directCount(body: string): number | undefined {
  let dictionaryDepth = 0
  let arrayDepth = 0
  let at = 0
  while (at < body.length) {
    if (body.startsWith(DICTIONARY_OPEN, at)) {
      dictionaryDepth += 1
      at += DICTIONARY_OPEN.length
      continue
    }
    if (body.startsWith(DICTIONARY_CLOSE, at)) {
      dictionaryDepth -= 1
      at += DICTIONARY_CLOSE.length
      continue
    }
    if (body[at] === '%') {
      while (at < body.length && body[at] !== '\n' && body[at] !== '\r') {
        at += 1
      }
      continue
    }
    if (body[at] === '(') {
      at = afterString(body, at)
      continue
    }
    if (body[at] === '[') {
      arrayDepth += 1
      at += 1
      continue
    }
    if (body[at] === ']') {
      arrayDepth -= 1
      at += 1
      continue
    }
    if (dictionaryDepth === 1 && arrayDepth === 0 && body.startsWith('/Count', at)) {
      const value = COUNT_VALUE.exec(body.slice(at + '/Count'.length))
      if (value !== null) {
        // A direct integer ends at the next key or dictionary close. A later
        // number can be the generation of an indirect reference (`5 0 R`),
        // not a page count; comments here are ambiguous too.
        const following = body.slice(at + '/Count'.length + value[0].length).trimStart()[0]
        return following === '/' || following === '>' ? Number(value[1]) : undefined
      }
    }
    at += 1
  }
  return undefined
}

/** The largest page-tree `/Count` in the text; undefined when there is none. */
function pageTreeCount(text: string): number | undefined {
  let best: number | undefined
  let inspected = 0
  for (const match of text.matchAll(PAGES_TYPE)) {
    inspected += 1
    if (inspected > PDF_PAGE_TREE_SCAN_LIMIT) {
      return undefined
    }
    const dictionary = enclosingDictionary(text, match.index)
    const count = directCount(dictionary?.body ?? '')
    if (
      count === undefined ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > PDF_PAGE_COUNT_MAX
    ) {
      return undefined
    }
    best = Math.max(best ?? 0, count)
  }
  return best
}

/** The PDF's page count, when its page tree can be read cheaply; undefined otherwise. */
export function pdfPageCount(bytes: Uint8Array): number | undefined {
  const text = latin1(bytes)
  // An object stream or encryption can hide the real Pages dictionary.
  // An unrelated visible one must not lower its budget reservation.
  const hasHiddenObjects =
    text.includes(OBJECT_STREAM_MARKER) ||
    text.includes(ENCRYPTION_MARKER) ||
    INDIRECT_TYPE_CANDIDATE.test(text) ||
    hasEscapedCriticalName(text) ||
    hasAmbiguousCommentGap(text)
  return hasHiddenObjects ? undefined : pageTreeCount(text)
}

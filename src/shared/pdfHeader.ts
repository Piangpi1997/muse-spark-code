// A browser-safe PDF signature check shared by the picker, paste/drop, and
// host parser. The signature may appear within the first 1 KiB.

import { PDF_HEADER_SIGNATURE, PDF_HEADER_WINDOW_BYTES } from './constants'

const PDF_HEADER_BYTES = new TextEncoder().encode(PDF_HEADER_SIGNATURE)

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length, PDF_HEADER_WINDOW_BYTES) - PDF_HEADER_BYTES.length
  for (let start = 0; start <= last; start += 1) {
    if (PDF_HEADER_BYTES.every((byte, index) => bytes[start + index] === byte)) {
      return true
    }
  }
  return false
}

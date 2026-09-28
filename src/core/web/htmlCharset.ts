// An HTML page's bytes as text (M69, PLAN.md D49): its encoding found as the
// HTML standard's encoding sniffing algorithm finds it (html-encoding-sniffer,
// the implementation jsdom uses): a byte order mark, then the Content-Type
// header's charset, then the prescan of the first 1024 bytes for a `<meta>`
// that declares one (comments and other attributes skipped as the standard
// says), else UTF-8. The standard leaves that last fallback to the user's
// locale; UTF-8 is what a page without any declaration most likely is.

import { TextDecoder } from 'node:util'
import sniffHtmlEncoding from 'html-encoding-sniffer'

const FALLBACK_ENCODING = 'utf8'

/** The page's text, decoded in the encoding its bytes, header and markup declare. */
export function decodeHtml(bytes: Uint8Array, headerCharset: string | undefined): string {
  const encoding = sniffHtmlEncoding(bytes, {
    ...(headerCharset !== undefined && { transportLayerEncodingLabel: headerCharset }),
    defaultEncoding: FALLBACK_ENCODING,
  })
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    // An encoding this runtime cannot decode (`replacement`, `x-user-defined`).
    decoder = new TextDecoder(FALLBACK_ENCODING)
  }
  return decoder.decode(bytes)
}

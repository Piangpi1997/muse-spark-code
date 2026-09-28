// Web fetch (M69, PLAN.md D49, the network-safety design of M44b): one
// public HTTPS page, read by the extension from the user's machine, for the
// model on either backend. Each hop of the fetch:
//
// - checks the URL (pageUrl.ts): `https:` only, no credentials, no local or
//   reserved name, no non-public address;
// - resolves the name here and refuses it when any answer is not a public
//   address, then PINS the first answer: the request goes to that address
//   (TLS still verifies the name), so no second lookup can move it into the
//   user's network. Through a proxy, the proxy is asked for that address
//   too (see src/host/web/pinnedRequest.ts);
// - follows a redirect on the same host, checked, resolved and pinned
//   again, at most WEB_FETCH_MAX_REDIRECTS times; a redirect to another host
//   is handed back to the model, which asks again (each host is approved on
//   its own);
// - reads at most WEB_FETCH_MAX_BYTES of an allowed content type within
//   WEB_FETCH_TIMEOUT_MS, then turns HTML into Markdown and leaves text as
//   it is.
//
// What the model receives marks the page as untrusted data between markers
// the page cannot know. Nothing here is billed: the fetch is the
// extension's own, not Meta's paid search. The transport and the resolver
// are the host's; this module decides.

import { Buffer } from 'node:buffer'
import { pipeline, Readable, type Transform } from 'node:stream'
import { TextDecoder } from 'node:util'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import * as z from 'zod/mini'
import {
  type AddressFamily,
  HTTP_REDIRECT_STATUSES,
  HTTP_SUCCESS_MAX,
  HTTP_SUCCESS_MIN,
  MODEL_TEXT,
  WEB_FETCH_CHARSET_SNIFF_BYTES,
  WEB_FETCH_HTML_TYPES,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_CONTENT_CHARS,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TEXT_TYPES,
  WEB_FETCH_TIMEOUT_MS,
} from '../../shared/constants'
import { fill } from '../../shared/l10n/text'
import { describeNetworkFailure, networkFailureMessage } from '../networkFailure'
import {
  type FailureFacts,
  redirectRefused,
  type WebFetchFailure,
  type WebFetchFailureKind,
  webFetchFailure,
} from './fetchFailure'
import { htmlToMarkdown } from './htmlToMarkdown'
import { approvalHost, type CheckedPageUrl, checkPageUrl } from './pageUrl'
import { addressFamily, isPublicAddress } from './publicAddress'

/** Where one request goes: the URL as sent, and the address it is pinned to. */
export interface PinnedTarget {
  readonly url: URL
  /** The URL's host: the name TLS verifies and the `Host` header carries. */
  readonly host: string
  /** The checked public address the connection is made to. */
  readonly address: string
  readonly family: AddressFamily
}

/** A response as the transport hands it over, its body not yet read. */
export interface PinnedResponse {
  readonly status: number
  /** Header names in lower case; a repeated header's values joined with `, `. */
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array>
  /** Lets the connection go without reading the rest of the body. */
  close(): void
}

export interface WebFetchDeps {
  /** Every address the name resolves to, from this machine's resolver. */
  readonly resolve: (host: string) => Promise<readonly string[]>
  /** One GET to the pinned address; rejects when it cannot be made or `signal` aborts. */
  readonly request: (target: PinnedTarget, signal: AbortSignal) => Promise<PinnedResponse>
  /** Fresh random hexadecimal for the markers around the page's content. */
  readonly newMarker: () => string
  /** The whole fetch's deadline; WEB_FETCH_TIMEOUT_MS unless a test shortens it. */
  readonly timeoutMs?: number
}

/** A page that was read. */
export interface WebPage {
  readonly url: string
  readonly finalUrl: string
  readonly status: number
  readonly type: string
  readonly bytes: number
}

export type WebFetchResult =
  | {
      readonly kind: 'page'
      readonly page: WebPage
      /** What the model receives: the header, the notice, and the marked content. */
      readonly text: string
    }
  | {
      /** A redirect to another host, handed back to the model (not followed). */
      readonly kind: 'moved'
      readonly location: string
      readonly text: string
    }
  | { readonly kind: 'failed'; readonly failure: WebFetchFailure }

/** The host's fetch: one URL, stopped by the turn's signal. */
export type WebFetcher = (url: string, signal: AbortSignal) => Promise<WebFetchResult>

const MEDIA_TYPE_SEPARATOR = ';'
const CHARSET_PARAMETER = 'charset='
const DEFAULT_CHARSET = 'utf8'
const IDENTITY = 'identity'
const LATIN1 = 'latin1'
const OPENING_QUOTE = /^["']/
// Where a charset's value ends, in a header or a `<meta>` tag.
const CHARSET_END = /[\s"';/>]/

/** A listener that has nothing to do until it is replaced. */
function ignore(): void {
  // Replaced before it can run; see unlessAborted.
}

/**
 * `pipeline`'s callback when the decompressor is what is read: the error it
 * reports has already destroyed the decompressor, and the read reports it.
 */
function settled(): void {
  // The failure reaches the reader through the destroyed decompressor.
}

class FetchRefused extends Error {
  public constructor(public readonly failure: WebFetchFailure) {
    super(failure.reason)
    this.name = 'FetchRefused'
  }
}

function refuse(kind: WebFetchFailureKind, facts: FailureFacts = {}): never {
  throw new FetchRefused(webFetchFailure(kind, facts))
}

/** `work`, or the signal's reason as soon as it aborts; `work` is left to settle. */
async function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = ignore
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The addresses a checked URL's request may be pinned to, in the resolver's
 * order, once every answer is checked: the request tries them in turn, and
 * never looks the name up again.
 */
async function pin(
  checked: CheckedPageUrl,
  deps: WebFetchDeps,
  signal: AbortSignal,
): Promise<readonly PinnedTarget[]> {
  const { host, url } = checked
  let addresses: readonly string[]
  if (checked.address === undefined) {
    try {
      addresses = await unlessAborted(deps.resolve(host), signal)
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error
      }
      refuse('unresolved', { host })
    }
  } else {
    addresses = [checked.address]
  }
  // A name with any non-public answer is refused whole: a rebinding setup
  // mixes a public answer with a private one.
  const blocked = addresses.find((address) => !isPublicAddress(address))
  if (blocked !== undefined) {
    refuse('privateAddress', { host, address: blocked })
  }
  const targets = addresses.flatMap((address) => {
    const family = addressFamily(address)
    return family === undefined ? [] : [{ url, host, address, family }]
  })
  if (targets.length === 0) {
    refuse('unresolved', { host })
  }
  return targets
}

/**
 * The first pinned address that answers. A connection that could not be
 * made moves on to the next checked address (a dual-stack name on a network
 * without IPv6, say); one that answered is the response, whatever it says.
 */
async function requestPinned(
  targets: readonly PinnedTarget[],
  deps: WebFetchDeps,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  let lastError: unknown
  for (const target of targets) {
    try {
      return await deps.request(target, signal)
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError
}

/** The headers the fetch reads, checked at the transport's boundary. */
const readHeadersSchema = z.object({
  'content-type': z.optional(z.string()),
  'content-length': z.optional(z.string()),
  'content-encoding': z.optional(z.string()),
  location: z.optional(z.string()),
})
type ReadHeaders = z.infer<typeof readHeadersSchema>

function headersOf(response: PinnedResponse): ReadHeaders {
  return readHeadersSchema.parse(response.headers)
}

/** A header's media type, lower case, without parameters. */
function mediaTypeOf(contentType: string): string {
  return (contentType.split(MEDIA_TYPE_SEPARATOR)[0] ?? '').trim().toLowerCase()
}

/** The `charset` parameter of a header or a meta tag, unquoted; undefined when absent. */
function charsetIn(text: string): string | undefined {
  const lower = text.toLowerCase()
  const at = lower.indexOf(CHARSET_PARAMETER)
  if (at === -1) {
    return undefined
  }
  const rest = text.slice(at + CHARSET_PARAMETER.length).replace(OPENING_QUOTE, '')
  const end = rest.search(CHARSET_END)
  const value = (end === -1 ? rest : rest.slice(0, end)).trim()
  return value === '' ? undefined : value
}

/**
 * The body through a decompressor. `pipeline` destroys the decompressor with
 * the body's error (an abort, a reset), so reading it fails rather than
 * waiting forever; its callback has nothing left to do.
 */
function through(
  body: AsyncIterable<Uint8Array>,
  decompressor: Transform,
): AsyncIterable<Uint8Array> {
  pipeline(Readable.from(body), decompressor, settled)
  return decompressor
}

/** The body as it came off the wire, decompressed; refused for an unknown coding. */
function decoded(
  body: AsyncIterable<Uint8Array>,
  coding: string | undefined,
): AsyncIterable<Uint8Array> {
  const name = (coding ?? IDENTITY).trim().toLowerCase()
  switch (name) {
    case '':
    case IDENTITY: {
      return body
    }
    case 'gzip':
    case 'x-gzip': {
      return through(body, createGunzip())
    }
    case 'deflate': {
      return through(body, createInflate())
    }
    case 'br': {
      return through(body, createBrotliDecompress())
    }
    default: {
      return refuse('encoding', { encoding: name })
    }
  }
}

/** The whole body within the cap; refused as soon as it passes it. */
async function readCapped(response: PinnedResponse, headers: ReadHeaders): Promise<Uint8Array> {
  const declared = Number(headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > WEB_FETCH_MAX_BYTES) {
    refuse('tooLarge')
  }
  const body = decoded(response.body, headers['content-encoding'])
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > WEB_FETCH_MAX_BYTES) {
      refuse('tooLarge')
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The body as text: the header's charset, else an HTML page's own `<meta>`, else UTF-8. */
function decodeText(bytes: Uint8Array, contentType: string, isHtml: boolean): string {
  let charset = charsetIn(contentType)
  if (charset === undefined && isHtml) {
    const head = Buffer.from(bytes.subarray(0, WEB_FETCH_CHARSET_SNIFF_BYTES)).toString(LATIN1)
    charset = charsetIn(head)
  }
  const label = charset ?? DEFAULT_CHARSET
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(label)
  } catch {
    return refuse('charset', { charset: label })
  }
  return decoder.decode(bytes)
}

/** What the model receives for a page: facts, the notice, and the marked content. */
function pageText(page: WebPage, content: string, isHtml: boolean, marker: string): string {
  const shown =
    content.length > WEB_FETCH_MAX_CONTENT_CHARS
      ? content.slice(0, WEB_FETCH_MAX_CONTENT_CHARS)
      : content
  const facts = [
    fill(MODEL_TEXT.webFetchHeader, {
      url: page.finalUrl,
      status: String(page.status),
      type: page.type,
      bytes: String(page.bytes),
    }),
    ...(page.finalUrl === page.url ? [] : [fill(MODEL_TEXT.webFetchRedirected, { url: page.url })]),
    isHtml ? MODEL_TEXT.webFetchConverted : MODEL_TEXT.webFetchAsText,
    ...(shown.length < content.length
      ? [
          fill(MODEL_TEXT.webFetchTruncated, {
            shown: String(shown.length),
            total: String(content.length),
          }),
        ]
      : []),
  ].join(' ')
  return [
    facts,
    MODEL_TEXT.webFetchUntrusted,
    fill(MODEL_TEXT.webFetchOpen, { marker }),
    shown,
    fill(MODEL_TEXT.webFetchClose, { marker }),
  ].join('\n')
}

/** The page read and converted, once its status and type are allowed. */
async function readPage(
  response: PinnedResponse,
  requested: URL,
  finalUrl: URL,
  deps: WebFetchDeps,
): Promise<WebFetchResult> {
  const { status } = response
  if (status < HTTP_SUCCESS_MIN || status > HTTP_SUCCESS_MAX) {
    refuse('httpStatus', { status })
  }
  const headers = headersOf(response)
  const contentType = headers['content-type']
  if (contentType === undefined || contentType.trim() === '') {
    refuse('noContentType')
  }
  const type = mediaTypeOf(contentType)
  const isHtml = WEB_FETCH_HTML_TYPES.has(type)
  if (!isHtml && !WEB_FETCH_TEXT_TYPES.has(type)) {
    refuse('contentType', { type })
  }
  const bytes = await readCapped(response, headers)
  const text = decodeText(bytes, contentType, isHtml)
  let content = text
  if (isHtml) {
    const converted = htmlToMarkdown(text, finalUrl)
    content =
      converted.title === undefined
        ? converted.markdown
        : `${fill(MODEL_TEXT.webFetchTitle, { title: converted.title })}\n\n${converted.markdown}`
  }
  const page: WebPage = {
    url: requested.href,
    finalUrl: finalUrl.href,
    status,
    type,
    bytes: bytes.byteLength,
  }
  return { kind: 'page', page, text: pageText(page, content, isHtml, deps.newMarker()) }
}

/** Why the request failed: a refusal, the deadline, or the network. */
function failureOf(error: unknown, deadline: AbortSignal): WebFetchFailure {
  if (error instanceof FetchRefused) {
    return error.failure
  }
  if (deadline.aborted) {
    return webFetchFailure('timeout')
  }
  return webFetchFailure('network', {
    detail: describeNetworkFailure(error).detail,
    visibleDetail: networkFailureMessage(error),
  })
}

/** The redirect's target: checked like the first URL, or handed back when it is another host's. */
function nextHop(
  response: PinnedResponse,
  headers: ReadHeaders,
  current: CheckedPageUrl,
): { readonly next: CheckedPageUrl } | { readonly moved: string } {
  const { location } = headers
  if (location === undefined || location.trim() === '') {
    refuse('redirectWithoutLocation', { status: response.status })
  }
  let target: URL
  try {
    target = new URL(location.trim(), current.url)
  } catch {
    return refuse('invalidUrl')
  }
  const checked = checkPageUrl(target.href)
  if (!checked.ok) {
    throw new FetchRefused(redirectRefused(checked.failure))
  }
  return approvalHost(checked.url) === approvalHost(current.url)
    ? { next: checked }
    : { moved: checked.url.href }
}

/** Every hop of one fetch, within the deadline and the redirect limit. */
async function fetchHops(
  first: CheckedPageUrl,
  deps: WebFetchDeps,
  signal: AbortSignal,
): Promise<WebFetchResult> {
  let current = first
  for (let redirects = 0; ; redirects += 1) {
    const targets = await pin(current, deps, signal)
    const response = await requestPinned(targets, deps, signal)
    try {
      if (!HTTP_REDIRECT_STATUSES.has(response.status)) {
        return await readPage(response, first.url, current.url, deps)
      }
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
        refuse('tooManyRedirects')
      }
      const hop = nextHop(response, headersOf(response), current)
      if ('moved' in hop) {
        const text = fill(MODEL_TEXT.webFetchMoved, { url: current.url.href, location: hop.moved })
        return { kind: 'moved', location: hop.moved, text }
      }
      current = hop.next
    } finally {
      response.close()
    }
  }
}

/**
 * Fetches one page. Resolves with the page, a redirect to another host, or
 * the reason nothing was read; rejects only when `turn` aborts (Stop).
 */
export async function fetchWebPage(
  rawUrl: string,
  deps: WebFetchDeps,
  turn: AbortSignal,
): Promise<WebFetchResult> {
  const first = checkPageUrl(rawUrl)
  if (!first.ok) {
    return { kind: 'failed', failure: first.failure }
  }
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS)
  const signal = AbortSignal.any([turn, deadline])
  try {
    return await fetchHops(first, deps, signal)
  } catch (error: unknown) {
    if (turn.aborted) {
      throw error
    }
    return { kind: 'failed', failure: failureOf(error, deadline) }
  }
}

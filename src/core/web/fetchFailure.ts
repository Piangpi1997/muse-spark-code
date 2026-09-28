// Why a web fetch did not happen or did not finish (M69, PLAN.md D49): the
// sentence the model reads (English, MODEL_TEXT) and the one the row shows
// (the display language, UI_TEXT), made together so they always agree.

import {
  MODEL_TEXT,
  UI_TEXT,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_URL_MAX_CHARS,
} from '../../shared/constants'
import { fill, formatBytes, formatNumber, formatUnit } from '../../shared/l10n/text'

const MS_PER_SECOND = 1000

export type WebFetchFailureKind =
  | 'invalidUrl'
  | 'notHttps'
  | 'credentials'
  | 'urlTooLong'
  | 'reservedHost'
  | 'privateAddress'
  | 'unresolved'
  | 'tooManyRedirects'
  | 'redirectWithoutLocation'
  | 'httpStatus'
  | 'tooLarge'
  | 'noContentType'
  | 'contentType'
  | 'encoding'
  | 'charset'
  | 'timeout'
  | 'network'

export interface WebFetchFailure {
  readonly kind: WebFetchFailureKind
  /** What the model is told, in English. */
  readonly reason: string
  /** What the row says, in the display language. */
  readonly visibleReason: string
}

/** The facts a failure's sentences name; each kind reads the ones it needs. */
export interface FailureFacts {
  readonly host?: string
  readonly address?: string
  readonly status?: number
  readonly type?: string
  readonly encoding?: string
  readonly charset?: string
  /** The network failure's technical detail (causes, redacted). */
  readonly detail?: string
  /** The same failure as the row says it: advice first (M56). */
  readonly visibleDetail?: string
}

const SECONDS = WEB_FETCH_TIMEOUT_MS / MS_PER_SECOND

/** The two sentences of a kind, filled from the facts. */
function sentences(kind: WebFetchFailureKind, facts: FailureFacts): readonly [string, string] {
  const host = facts.host ?? ''
  const status = String(facts.status ?? '')
  switch (kind) {
    case 'invalidUrl': {
      return [MODEL_TEXT.webFetchInvalidUrl, UI_TEXT.webFetchInvalidUrl]
    }
    case 'notHttps': {
      return [MODEL_TEXT.webFetchNotHttps, UI_TEXT.webFetchNotHttps]
    }
    case 'credentials': {
      return [MODEL_TEXT.webFetchCredentials, UI_TEXT.webFetchCredentials]
    }
    case 'urlTooLong': {
      return [
        fill(MODEL_TEXT.webFetchUrlTooLong, { max: String(WEB_FETCH_URL_MAX_CHARS) }),
        fill(UI_TEXT.webFetchUrlTooLong, { max: formatNumber(WEB_FETCH_URL_MAX_CHARS) }),
      ]
    }
    case 'reservedHost': {
      return [
        fill(MODEL_TEXT.webFetchReservedHost, { host }),
        fill(UI_TEXT.webFetchReservedHost, { host }),
      ]
    }
    case 'privateAddress': {
      const address = facts.address ?? ''
      return [
        fill(MODEL_TEXT.webFetchPrivateAddress, { host, address }),
        fill(UI_TEXT.webFetchPrivateAddress, { host, address }),
      ]
    }
    case 'unresolved': {
      return [
        fill(MODEL_TEXT.webFetchUnresolved, { host }),
        fill(UI_TEXT.webFetchUnresolved, { host }),
      ]
    }
    case 'tooManyRedirects': {
      return [
        fill(MODEL_TEXT.webFetchTooManyRedirects, { max: String(WEB_FETCH_MAX_REDIRECTS) }),
        fill(UI_TEXT.webFetchTooManyRedirects, { max: formatNumber(WEB_FETCH_MAX_REDIRECTS) }),
      ]
    }
    case 'redirectWithoutLocation': {
      return [
        fill(MODEL_TEXT.webFetchRedirectWithoutLocation, { status }),
        fill(UI_TEXT.webFetchRedirectWithoutLocation, { status }),
      ]
    }
    case 'httpStatus': {
      return [
        fill(MODEL_TEXT.webFetchHttpStatus, { status }),
        fill(UI_TEXT.webFetchHttpStatus, { status }),
      ]
    }
    case 'tooLarge': {
      return [
        fill(MODEL_TEXT.webFetchTooLarge, { max: String(WEB_FETCH_MAX_BYTES) }),
        fill(UI_TEXT.webFetchTooLarge, { size: formatBytes(WEB_FETCH_MAX_BYTES) }),
      ]
    }
    case 'noContentType': {
      return [MODEL_TEXT.webFetchNoContentType, UI_TEXT.webFetchNoContentType]
    }
    case 'contentType': {
      const type = facts.type ?? ''
      return [
        fill(MODEL_TEXT.webFetchContentType, { type }),
        fill(UI_TEXT.webFetchContentType, { type }),
      ]
    }
    case 'encoding': {
      const encoding = facts.encoding ?? ''
      return [
        fill(MODEL_TEXT.webFetchEncoding, { encoding }),
        fill(UI_TEXT.webFetchEncoding, { encoding }),
      ]
    }
    case 'charset': {
      const charset = facts.charset ?? ''
      return [
        fill(MODEL_TEXT.webFetchCharset, { charset }),
        fill(UI_TEXT.webFetchCharset, { charset }),
      ]
    }
    case 'timeout': {
      return [
        fill(MODEL_TEXT.webFetchTimeout, { seconds: String(SECONDS) }),
        fill(UI_TEXT.webFetchTimeout, { duration: formatUnit(SECONDS, 'second') }),
      ]
    }
    case 'network': {
      return [
        fill(MODEL_TEXT.webFetchNetwork, { detail: facts.detail ?? '' }),
        fill(UI_TEXT.webFetchNetwork, { detail: facts.visibleDetail ?? facts.detail ?? '' }),
      ]
    }
  }
}

export function webFetchFailure(
  kind: WebFetchFailureKind,
  facts: FailureFacts = {},
): WebFetchFailure {
  const [reason, visibleReason] = sentences(kind, facts)
  return { kind, reason, visibleReason }
}

/** A redirect to a refused URL: the model hears which rule refused it. */
export function redirectRefused(refusal: WebFetchFailure): WebFetchFailure {
  return {
    kind: refusal.kind,
    reason: fill(MODEL_TEXT.webFetchRedirectRefused, { reason: refusal.reason }),
    visibleReason: fill(UI_TEXT.webFetchRedirectRefused, { reason: refusal.visibleReason }),
  }
}

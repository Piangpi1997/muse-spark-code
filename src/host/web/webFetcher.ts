// The window's web fetch (M69, PLAN.md D49): the core fetch over this
// machine's resolver and the pinned HTTPS transport, shared by the Model API
// backend's `web_fetch` and the `ide` server's `webFetch` for Muse Code. The
// log names the host and the outcome only: a path or a query can carry
// what the conversation put there.

import { randomBytes } from 'node:crypto'
import { ADDRCONFIG } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { nat64PrefixesOf } from '../../core/web/publicAddress'
import {
  fetchWebPage,
  type Nat64Discovery,
  type WebFetcher,
  type WebFetchResult,
} from '../../core/web/webFetch'
import {
  ADDRESS_FAMILIES,
  NAT64_ABSENT_CODES,
  NAT64_DISCOVERY_NAME,
  WEB_FETCH_MARKER_BYTES,
} from '../../shared/constants'
import type { Logger } from '../logger'
import { pinnedHttpsRequest } from './pinnedRequest'

/**
 * Every address the name resolves to, as the operating system's resolver
 * answers a connection's lookup (Node's `net` asks with ADDRCONFIG: no IPv6
 * answers on a machine without an IPv6 address), in its order.
 */
async function resolveAll(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true, order: 'verbatim', hints: ADDRCONFIG })
  return answers.map((answer) => answer.address)
}

/**
 * The AAAA answers for `ipv4only.arpa`, from the resolver the page's own
 * name was looked up with, so a DNS64 that synthesized those answers is the
 * one asked.
 */
export type Nat64Lookup = () => Promise<readonly string[]>

async function lookupNat64(): Promise<readonly string[]> {
  const answers = await lookup(NAT64_DISCOVERY_NAME, { all: true, family: ADDRESS_FAMILIES.ipv6 })
  return answers.map((answer) => answer.address)
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'error'
}

/**
 * The network's NAT64 prefixes (RFC 7050). Only a definite "no AAAA record"
 * means no DNS64. A lookup that failed otherwise (a timeout, SERVFAIL), or
 * answers that carry no RFC 6052 prefix, leave NAT64 unknown: the fetch
 * then uses no IPv6 answer, since any could carry a private address.
 */
export async function discoverNat64(
  lookupAnswers: Nat64Lookup,
  log: Logger,
): Promise<Nat64Discovery> {
  let answers: readonly string[]
  try {
    answers = await lookupAnswers()
  } catch (error: unknown) {
    const code = codeOf(error)
    if (NAT64_ABSENT_CODES.has(code)) {
      log.trace(`Web fetch: no NAT64 prefix (${NAT64_DISCOVERY_NAME}: ${code})`)
      return { isKnown: true, prefixes: [] }
    }
    log.info(
      `Web fetch: NAT64 discovery failed (${NAT64_DISCOVERY_NAME}: ${code}); IPv6 answers are not used`,
    )
    return { isKnown: false, detail: `${NAT64_DISCOVERY_NAME}: ${code}` }
  }
  const prefixes = nat64PrefixesOf(answers)
  if (prefixes.length === 0 && answers.length > 0) {
    const shown = answers.join(', ')
    log.info(
      `Web fetch: ${NAT64_DISCOVERY_NAME} answered ${shown}, which carries no NAT64 prefix; IPv6 answers are not used`,
    )
    return { isKnown: false, detail: `${NAT64_DISCOVERY_NAME}: ${shown}` }
  }
  return { isKnown: true, prefixes }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(not a URL)'
  }
}

function outcomeOf(result: WebFetchResult): string {
  switch (result.kind) {
    case 'page': {
      const { page } = result
      return `HTTP ${String(page.status)}, ${page.type}, ${String(page.bytes)} bytes`
    }
    case 'moved': {
      return `redirected to another host (${hostOf(result.location)}); handed back to the model`
    }
    case 'failed': {
      return `refused or failed: ${result.failure.kind}`
    }
  }
}

export function createWebFetcher(
  log: Logger,
  lookupAnswers: Nat64Lookup = lookupNat64,
): WebFetcher {
  return async (url, signal) => {
    const result = await fetchWebPage(
      url,
      {
        resolve: resolveAll,
        nat64: async () => await discoverNat64(lookupAnswers, log),
        request: pinnedHttpsRequest,
        newMarker: () => randomBytes(WEB_FETCH_MARKER_BYTES).toString('hex'),
      },
      signal,
    )
    log.info(`Web fetch from ${hostOf(url)}: ${outcomeOf(result)}`)
    return result
  }
}

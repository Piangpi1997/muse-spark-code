// The window's web fetch (M69, PLAN.md D49): the core fetch over this
// machine's resolver and the pinned HTTPS transport, shared by the Model API
// backend's `web_fetch` and the `ide` server's `webFetch` for Muse Code. The
// log names the host and the outcome only: a path or a query can carry
// what the conversation put there.

import { randomBytes } from 'node:crypto'
import { ADDRCONFIG } from 'node:dns'
import { lookup, Resolver } from 'node:dns/promises'
import { nat64PrefixesOf, type Nat64Prefix } from '../../core/web/publicAddress'
import { fetchWebPage, type WebFetcher, type WebFetchResult } from '../../core/web/webFetch'
import {
  NAT64_DISCOVERY_NAME,
  NAT64_DISCOVERY_TIMEOUT_MS,
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

/** The AAAA answers for `ipv4only.arpa`: none unless the network's DNS64 synthesizes them. */
export type Nat64Lookup = () => Promise<readonly string[]>

async function lookupNat64(): Promise<readonly string[]> {
  const resolver = new Resolver({ timeout: NAT64_DISCOVERY_TIMEOUT_MS, tries: 1 })
  return await resolver.resolve6(NAT64_DISCOVERY_NAME)
}

/**
 * The network's NAT64 prefixes (RFC 7050). A network without DNS64 answers
 * `ipv4only.arpa` with no AAAA record, which is an error to the resolver:
 * then there is no prefix, and the log says the lookup failed.
 */
export async function discoverNat64(
  lookupAnswers: Nat64Lookup,
  log: Logger,
): Promise<readonly Nat64Prefix[]> {
  try {
    return nat64PrefixesOf(await lookupAnswers())
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error'
    log.trace(`Web fetch: no NAT64 prefix from ${NAT64_DISCOVERY_NAME} (${code})`)
    return []
  }
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
        nat64Prefixes: async () => await discoverNat64(lookupAnswers, log),
        request: pinnedHttpsRequest,
        newMarker: () => randomBytes(WEB_FETCH_MARKER_BYTES).toString('hex'),
      },
      signal,
    )
    log.info(`Web fetch from ${hostOf(url)}: ${outcomeOf(result)}`)
    return result
  }
}

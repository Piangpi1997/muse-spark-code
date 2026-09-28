// Web fetch's transport (M69, PLAN.md D49): one HTTPS GET made to the
// address the fetch checked, never to a name looked up again. Node's `https`
// is asked to connect to that IP address; TLS still sends and verifies the
// page's own name (`servername`), and the `Host` header carries it.
//
// Through VS Code's proxy: VS Code patches Node's `https` module in place
// for every extension (proxyResolver.ts in VS Code 1.125 and later, with
// @vscode/proxy-agent), so this request takes the user's proxy (`http.proxy`,
// the system's or a PAC file's, `http.noProxy`) and their certificates as
// the Model API's `fetch` does (M56). Its proxy agent tunnels with
// `CONNECT <address>:<port>` for the address given here, and upgrades the
// tunnel to TLS with our `servername`, so a proxy never resolves the name
// either: the request stays pinned or fails. VS Code's patched `fetch`
// cannot pin: it replaces a caller's dispatcher with its own agent, which
// keeps only the certificates and HTTP/2 options (@vscode/proxy-agent's
// `createFetchPatch`, read 2026-09-27), so the fetch uses `https`.
//
// Only an answer that came over TLS is read. A proxy that refuses the tunnel
// (a policy against addresses, missing credentials) answers the CONNECT
// itself, and https-proxy-agent hands that answer to the request on a plain
// socket; it is refused as the proxy's, never read as the page's, in the
// words M56's network failures use ("Proxy response (403)").

import type { IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { Socket } from 'node:net'
import type { PinnedResponse, PinnedTarget } from '../../core/web/webFetch'
import { addressFamily } from '../../core/web/publicAddress'
import {
  WEB_FETCH_ACCEPT,
  WEB_FETCH_ACCEPT_ENCODING,
  WEB_FETCH_DEFAULT_PORT,
  WEB_FETCH_USER_AGENT,
} from '../../shared/constants'

/** Node's `https.request`, or a test's stand-in with the same shape. */
export type RequestFunction = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => {
  on(event: 'error', listener: (error: Error) => void): unknown
  end(): unknown
  destroy(): unknown
}

/** The request options for a pinned GET: the address to connect to, the name to verify. */
export function pinnedOptions(target: PinnedTarget, signal: AbortSignal): RequestOptions {
  const { url } = target
  return {
    method: 'GET',
    host: target.address,
    family: target.family,
    port: url.port === '' ? WEB_FETCH_DEFAULT_PORT : Number(url.port),
    path: `${url.pathname}${url.search}`,
    // An IP address in the URL is verified as an address; a name is sent
    // and verified as a name (a name, never an address, may go in SNI).
    ...(addressFamily(target.host) === undefined && { servername: target.host }),
    headers: {
      host: url.host,
      'user-agent': WEB_FETCH_USER_AGENT,
      accept: WEB_FETCH_ACCEPT,
      'accept-encoding': WEB_FETCH_ACCEPT_ENCODING,
    },
    signal,
  }
}

/** A response's headers as the fetch reads them: one string each, names in lower case. */
function headersOf(response: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

/** Whether the answer arrived over TLS, as only the pinned server's can. */
function isOverTls(socket: Socket | null): boolean {
  return socket !== null && 'encrypted' in socket && socket.encrypted === true
}

/**
 * One pinned GET; rejects when it cannot be made, when a proxy answered
 * instead of the server, or when the signal aborts. `isTlsRequired` is off
 * only for the tests' plain loopback server.
 */
export function pinnedHttpsRequest(
  target: PinnedTarget,
  signal: AbortSignal,
  request: RequestFunction = httpsRequest,
  isTlsRequired = true,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(pinnedOptions(target, signal), (response) => {
      if (isTlsRequired && !isOverTls(response.socket)) {
        response.destroy()
        outgoing.destroy()
        reject(
          new Error(
            `Proxy response (${String(response.statusCode ?? 0)}) to the tunnel for the pinned address ${target.address}; nothing was sent to it`,
          ),
        )
        return
      }
      resolve({
        status: response.statusCode ?? 0,
        headers: headersOf(response),
        body: response,
        close: () => {
          response.destroy()
          outgoing.destroy()
        },
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

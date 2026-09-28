import { Buffer } from 'node:buffer'
import {
  createServer,
  type IncomingHttpHeaders,
  request as httpRequest,
  type Server,
} from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { describeNetworkFailure } from '../../src/core/networkFailure'
import type { PinnedTarget } from '../../src/core/web/webFetch'
import { pinnedHttpsRequest, pinnedOptions } from '../../src/host/web/pinnedRequest'
import {
  WEB_FETCH_ACCEPT_ENCODING,
  WEB_FETCH_DEFAULT_PORT,
  WEB_FETCH_USER_AGENT,
} from '../../src/shared/constants'

const servers: Server[] = []
// The loopback server speaks plain HTTP, so these tests lift the TLS
// requirement, except the one that shows it.
const IS_TLS_REQUIRED = false

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(resolve)
        }),
    ),
  )
})

/** A loopback server standing in for the pinned address; it records what it was asked. */
async function listen(
  handler: (
    headers: IncomingHttpHeaders,
    url: string | undefined,
  ) => { body: string; hang?: boolean },
): Promise<{
  port: number
  seen: { host: string | undefined; url: string | undefined; headers: IncomingHttpHeaders }[]
}> {
  const seen: {
    host: string | undefined
    url: string | undefined
    headers: IncomingHttpHeaders
  }[] = []
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url, headers: request.headers })
    const reply = handler(request.headers, request.url)
    response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] })
    if (reply.hang === true) {
      response.write(reply.body)
      return
    }
    response.end(reply.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the loopback server has no port')
  }
  return { port: address.port, seen }
}

function target(url: string, address = '127.0.0.1'): PinnedTarget {
  const parsed = new URL(url)
  return { url: parsed, host: parsed.hostname.replaceAll(/^\[|\]$/g, ''), address, family: 4 }
}

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  return Buffer.concat(await Array.fromAsync(body)).toString('utf8')
}

describe('pinnedHttpsRequest (M69)', () => {
  it('connects to the pinned address and names the page only in TLS and the Host header', () => {
    const options = pinnedOptions(
      target('https://docs.example.com/a/b?x=1#frag', '93.184.215.14'),
      new AbortController().signal,
    )
    expect(options).toMatchObject({
      method: 'GET',
      host: '93.184.215.14',
      family: 4,
      port: WEB_FETCH_DEFAULT_PORT,
      path: '/a/b?x=1',
      servername: 'docs.example.com',
      headers: {
        host: 'docs.example.com',
        'user-agent': WEB_FETCH_USER_AGENT,
        'accept-encoding': WEB_FETCH_ACCEPT_ENCODING,
      },
    })
    // A URL that names an address is verified as that address: no SNI name.
    const literal = pinnedOptions(
      target('https://8.8.8.8:8443/', '8.8.8.8'),
      new AbortController().signal,
    )
    expect(literal).toMatchObject({
      host: '8.8.8.8',
      port: 8443,
      headers: { host: '8.8.8.8:8443' },
    })
    expect(literal).not.toHaveProperty('servername')
  })

  it('sends the request to the address, never looking the name up', async () => {
    const { port, seen } = await listen(() => ({ body: 'hello' }))
    const response = await pinnedHttpsRequest(
      target(`https://never-resolved.invalid:${String(port)}/p?q=1`),
      new AbortController().signal,
      httpRequest,
      IS_TLS_REQUIRED,
    )
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/plain')
    expect(response.headers['set-cookie']).toBe('a=1, b=2')
    expect(await text(response.body)).toBe('hello')
    response.close()
    expect(seen).toMatchObject([{ host: `never-resolved.invalid:${String(port)}`, url: '/p?q=1' }])
    expect(seen[0]?.headers['user-agent']).toBe(WEB_FETCH_USER_AGENT)
  })

  it('stops reading when the fetch aborts, and rejects a connection it cannot make', async () => {
    const { port } = await listen(() => ({ body: 'partial', hang: true }))
    const controller = new AbortController()
    const response = await pinnedHttpsRequest(
      target(`https://docs.example.com:${String(port)}/`),
      controller.signal,
      httpRequest,
      IS_TLS_REQUIRED,
    )
    const reading = text(response.body)
    controller.abort()
    await expect(reading).rejects.toThrow()
    const closed = await listen(() => ({ body: '' }))
    const port2 = closed.port
    await new Promise((resolve) => {
      servers.pop()?.close(resolve)
    })
    await expect(
      pinnedHttpsRequest(
        target(`https://docs.example.com:${String(port2)}/`),
        new AbortController().signal,
        httpRequest,
        IS_TLS_REQUIRED,
      ),
    ).rejects.toThrow(/ECONNREFUSED/)
  })

  it("refuses an answer that did not come over TLS: a proxy's, never the page", async () => {
    const { port } = await listen(() => ({ body: 'Forbidden by policy' }))
    const refusal = pinnedHttpsRequest(
      target(`https://docs.example.com:${String(port)}/`),
      new AbortController().signal,
      httpRequest,
    )
    let refused: unknown
    try {
      await refusal
    } catch (error: unknown) {
      refused = error
    }
    expect(String(refused)).toContain(
      'Proxy response (200) to the tunnel for the pinned address 127.0.0.1',
    )
    // M56's network failures read it as a proxy's refusal, with their advice.
    expect(describeNetworkFailure(refused)).toMatchObject({
      kind: 'proxyRefused',
      proxyStatus: 200,
    })
  })
})

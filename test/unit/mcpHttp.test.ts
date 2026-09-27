import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpConnection } from '../../src/core/backends/modelapi/mcp/connection'
import { McpHttpTransport } from '../../src/core/backends/modelapi/mcp/http'
import { FakeLogOutputChannel } from './helpers/fakes'
import {
  type FakeMcpHttp,
  type FakeMcpHttpOptions,
  startFakeMcpHttp,
} from './helpers/fakeMcpHttpServer'
import { countLogged } from './helpers/logText'

const servers: FakeMcpHttp[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function connect(
  options: FakeMcpHttpOptions = {},
  headers: Readonly<Record<string, string>> = {},
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  const server = await startFakeMcpHttp(options)
  servers.push(server)
  const log = new FakeLogOutputChannel()
  const transport = new McpHttpTransport({
    name: 'remote',
    url: server.url,
    headers,
    fetch: fetcher,
    log,
  })
  const connection = new McpConnection(transport, { name: 'remote', clientVersion: '1', log })
  return { server, log, transport, connection }
}

const methods = (server: FakeMcpHttp) =>
  server.requests.map((request) => {
    const body = request.body
    const method =
      typeof body === 'object' && body !== null && 'method' in body ? String(body.method) : 'answer'
    return `${request.method} ${request.body === undefined ? '' : method}`.trim()
  })

describe('McpHttpTransport (M50)', () => {
  it('speaks MCP over POST with JSON replies, sending the session and the revision back', async () => {
    const { server, connection, transport } = await connect(
      { sessionId: 'sess-1', token: 't0k' },
      { Authorization: 'Bearer t0k' },
    )
    await connection.initialize(5000)
    const tools = await connection.listTools(5000)
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'lookup'])
    expect(await connection.callTool('echo', { text: 'hi' }, { timeoutMs: 5000 })).toEqual({
      content: [{ type: 'text', text: 'echo: hi' }],
    })
    await transport.close()
    expect(methods(server)).toEqual([
      'POST initialize',
      'POST notifications/initialized',
      'POST tools/list',
      'POST tools/call',
      'DELETE',
    ])
    const [first, second] = server.requests
    expect(first?.headers.accept).toBe('application/json, text/event-stream')
    expect(first?.headers['mcp-session-id']).toBeUndefined()
    expect(second?.headers['mcp-session-id']).toBe('sess-1')
    expect(second?.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(server.requests.at(-1)?.headers['mcp-session-id']).toBe('sess-1')
    await expect(connection.callTool('echo', {}, { timeoutMs: 5000 })).rejects.toThrow(
      'the connection is closed',
    )
  })

  it("reads an event-stream reply, answering the server's own ping on the way", async () => {
    const { server, connection, log } = await connect({ reply: 'sse' })
    await connection.initialize(5000)
    expect(await connection.callTool('echo', { text: 'x' }, { timeoutMs: 5000 })).toEqual({
      content: [{ type: 'text', text: 'echo: x' }],
    })
    await vi.waitFor(() => {
      expect(server.requests.at(-1)?.body).toEqual({ jsonrpc: '2.0', id: 'srv-ping', result: {} })
    })
    expect(countLogged(log, 'MCP server remote (info): working')).toBe(1)
  })

  it('says when an event stream ends without the answer', async () => {
    const { connection } = await connect({ reply: 'sse', isAnswerMissing: true })
    await connection.initialize(5000)
    await expect(connection.callTool('echo', {}, { timeoutMs: 5000 })).rejects.toThrow(
      "the server's reply to tools/call carried no answer",
    )
  })

  it('starts a new session when the server forgot the old one', async () => {
    const { server, connection } = await connect({ sessionId: 'sess-2', expireAt: 3 })
    await connection.initialize(5000)
    await connection.listTools(5000)
    expect(await connection.callTool('echo', { text: 'again' }, { timeoutMs: 5000 })).toEqual({
      content: [{ type: 'text', text: 'echo: again' }],
    })
    expect(methods(server)).toEqual([
      'POST initialize',
      'POST notifications/initialized',
      'POST tools/list',
      'POST tools/call',
      'POST initialize',
      'POST notifications/initialized',
      'POST tools/call',
    ])
  })

  it('says a refused credential is not a muse mcp login matter, and names the scheme', async () => {
    const { connection } = await connect({ token: 'right' }, { Authorization: 'Bearer wrong' })
    await expect(connection.initialize(5000)).rejects.toThrow(
      /^HTTP 401: the server refused the credentials \(it asks for Bearer\)\. A sign-in made with muse mcp login is Muse Code's own/,
    )
  })

  it('refuses a redirect, so no header follows it elsewhere', async () => {
    const elsewhere = await startFakeMcpHttp()
    servers.push(elsewhere)
    const { connection } = await connect(
      { redirectTo: elsewhere.url },
      { Authorization: 'Bearer x' },
    )
    await expect(connection.initialize(5000)).rejects.toThrow(
      /^the server could not be reached: fetch failed: .*redirect/,
    )
    expect(elsewhere.requests).toEqual([])
  })

  it('refuses a reply over the cap', async () => {
    const { connection } = await connect({ isHuge: true })
    await connection.initialize(5000)
    await expect(connection.callTool('echo', {}, { timeoutMs: 20_000 })).rejects.toThrow(
      "the server's reply is over 20 MiB",
    )
  })

  it('shows the status of a failed reply, and what a reply of the wrong kind was', async () => {
    const replies: Response[] = [
      new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }),
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{ nope', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('', { status: 500 }),
    ]
    const fetcher: typeof fetch = () => Promise.resolve(replies.shift() ?? new Response(''))
    const { connection } = await connect({}, {}, fetcher)
    await expect(connection.initialize(1000)).rejects.toThrow('HTTP 502 Bad Gateway')
    await expect(connection.initialize(1000)).rejects.toThrow('the server answered with text/html')
    await expect(connection.initialize(1000)).rejects.toThrow('JSON that does not parse')
    await expect(connection.initialize(1000)).rejects.toThrow(/^HTTP 500/)
  })

  it('logs an event that is not JSON, and a session it could not end', async () => {
    const events =
      'data: not json\n\ndata:\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}\n\n'
    const replies: Response[] = [
      new Response(events, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's' },
      }),
      new Response(null, { status: 202 }),
    ]
    const fetcher: typeof fetch = (_input, init) =>
      init?.method === 'DELETE'
        ? Promise.reject(new TypeError('offline'))
        : Promise.resolve(replies.shift() ?? new Response(null, { status: 202 }))
    const { connection, transport, log } = await connect({}, {}, fetcher)
    await connection.initialize(1000)
    await transport.close()
    expect(countLogged(log, 'an event that is not JSON; skipped')).toBe(1)
    expect(countLogged(log, 'session was not ended: offline')).toBe(1)
    transport.onClose()
  })

  it('never echoes remote error bodies or challenge parameters into errors or logs', async () => {
    const token = 'fixture-private-header-value'
    const failures = [
      new Response(token, {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="${token}"` },
      }),
      new Response(token, { status: 502, statusText: 'Bad Gateway' }),
    ]
    const fetcher: typeof fetch = (_input, init) => {
      const failure = failures.shift()
      if (failure !== undefined) {
        return Promise.resolve(failure)
      }
      if (typeof init?.body !== 'string') {
        throw new TypeError('expected a JSON request body')
      }
      const body: unknown = JSON.parse(init.body)
      if (typeof body === 'object' && body !== null && 'id' in body) {
        const event = `data: ${token}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })}\n\n`
        return Promise.resolve(
          new Response(event, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    const log = new FakeLogOutputChannel()
    const transport = new McpHttpTransport({
      name: 'remote',
      url: 'https://mcp.invalid/test',
      headers: { Authorization: `Bearer ${token}` },
      fetch: fetcher,
      log,
    })
    const connection = new McpConnection(transport, { name: 'remote', clientVersion: '1', log })
    const credentialCall = connection.initialize(1000)
    await expect(credentialCall).rejects.toThrow('HTTP 401')
    await expect(credentialCall).rejects.not.toThrow(token)
    const serverCall = connection.initialize(1000)
    await expect(serverCall).rejects.toThrow('HTTP 502 Bad Gateway')
    await expect(serverCall).rejects.not.toThrow(token)
    await connection.initialize(1000)
    expect(countLogged(log, token)).toBe(0)
  })
})

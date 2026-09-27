import { describe, expect, it, vi } from 'vitest'
import {
  McpConnection,
  McpSessionExpiredError,
  type McpTransport,
} from '../../src/core/backends/modelapi/mcp/connection'
import type { OutgoingMessage } from '../../src/core/backends/modelapi/mcp/protocol'
import { FakeLogOutputChannel } from './helpers/fakes'
import { countLogged } from './helpers/logText'

type Reply = (message: OutgoingMessage) => readonly unknown[] | Error | undefined

/** A transport whose server is a function: each message sent gets these replies. */
class ScriptedTransport implements McpTransport {
  private readonly listeners = new Set<(message: unknown) => void>()
  private readonly closers = new Set<(reason: string) => void>()
  public readonly sent: OutgoingMessage[] = []
  public version: string | undefined
  public isClosed = false

  public constructor(public reply: Reply) {}

  public send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message)
    const replies = this.reply(message)
    if (replies instanceof Error) {
      return Promise.reject(replies)
    }
    const answers = replies ?? []
    for (const reply of answers) {
      this.deliver(reply)
    }
    return Promise.resolve()
  }

  public deliver(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message)
    }
  }

  public end(reason: string): void {
    for (const closer of this.closers) {
      closer(reason)
    }
  }

  public setProtocolVersion(version: string): void {
    this.version = version
  }

  public onMessage(listener: (message: unknown) => void): void {
    this.listeners.add(listener)
  }

  public onClose(listener: (reason: string) => void): void {
    this.closers.add(listener)
  }

  public close(): Promise<void> {
    this.isClosed = true
    return Promise.resolve()
  }
}

const TOOL = { name: 'echo', inputSchema: { type: 'object' } }

function methodOf(message: OutgoingMessage): string | undefined {
  return 'method' in message ? message.method : undefined
}

function idOf(message: OutgoingMessage): string | number | undefined {
  return 'id' in message ? message.id : undefined
}

/** A server that answers the handshake, lists `pages` of tools and echoes calls. */
function server(
  options: { version?: string; hasTools?: boolean; pages?: number; call?: Reply } = {},
): Reply {
  return (message) => {
    const id = idOf(message)
    const params = 'params' in message ? message.params : undefined
    switch (methodOf(message)) {
      case 'initialize': {
        return [
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: options.version ?? '2025-06-18',
              capabilities: options.hasTools === false ? {} : { tools: {} },
              serverInfo: { name: 'fake' },
            },
          },
        ]
      }
      case 'tools/list': {
        const page = Number(params?.['cursor'] ?? 0)
        const isLast = page + 1 >= (options.pages ?? 1)
        return [
          {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{ ...TOOL, name: `tool${String(page)}` }, { nameless: true }],
              ...(!isLast && { nextCursor: String(page + 1) }),
            },
          },
        ]
      }
      case 'tools/call': {
        return (options.call ?? (() => [{ jsonrpc: '2.0', id, result: { content: [] } }]))(message)
      }
      default: {
        return undefined
      }
    }
  }
}

function connect(reply: Reply) {
  const transport = new ScriptedTransport(reply)
  const log = new FakeLogOutputChannel()
  const connection = new McpConnection(transport, { name: 'fake', clientVersion: '9.9.9', log })
  return { transport, log, connection }
}

describe('McpConnection (M50)', () => {
  it('shakes hands as the specification says, and agrees the revision', async () => {
    const { transport, connection } = connect(server({ version: '2025-03-26' }))
    await connection.initialize(1000)
    expect(transport.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'muse-spark-code', version: '9.9.9' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    expect(transport.version).toBe('2025-03-26')
    expect(connection.isOpen).toBe(true)
  })

  it('refuses a server that speaks another revision or answers nonsense', async () => {
    await expect(
      connect(server({ version: '1999-01-01' })).connection.initialize(1000),
    ).rejects.toThrow('the server speaks MCP 1999-01-01')
    const nonsense = connect((message) => [
      { jsonrpc: '2.0', id: idOf(message), result: { no: 1 } },
    ])
    await expect(nonsense.connection.initialize(1000)).rejects.toThrow('not an initialize result')
  })

  it('lists every page of tools, skipping one without a name', async () => {
    const { connection, log } = connect(server({ pages: 3 }))
    await connection.initialize(1000)
    const tools = await connection.listTools(1000)
    expect(tools.map((tool) => tool.name)).toEqual(['tool0', 'tool1', 'tool2'])
    expect(countLogged(log, 'without a name')).toBe(3)
  })

  it('lists nothing for a server without tools, and stops after twenty pages', async () => {
    const none = connect(server({ hasTools: false }))
    await none.connection.initialize(1000)
    expect(await none.connection.listTools(1000)).toEqual([])
    expect(none.transport.sent.map((message) => methodOf(message))).not.toContain('tools/list')
    const endless = connect(server({ pages: 100 }))
    await endless.connection.initialize(1000)
    expect(await endless.connection.listTools(1000)).toHaveLength(20)
    expect(countLogged(endless.log, 'more than 20 pages')).toBeGreaterThan(0)
    const broken = connect((message) =>
      methodOf(message) === 'tools/list'
        ? [{ jsonrpc: '2.0', id: idOf(message), result: { tools: 'none' } }]
        : server()(message),
    )
    await broken.connection.initialize(1000)
    await expect(broken.connection.listTools(1000)).rejects.toThrow('without a list of tools')
  })

  it('calls a tool, and turns a JSON-RPC error into its message', async () => {
    const { connection } = connect(
      server({
        call: (message) => {
          const params = 'params' in message ? message.params : undefined
          return [
            params?.['name'] === 'bad'
              ? {
                  jsonrpc: '2.0',
                  id: idOf(message),
                  error: { code: -32_602, message: 'Unknown tool' },
                }
              : {
                  jsonrpc: '2.0',
                  id: idOf(message),
                  result: { content: [{ type: 'text', text: 'hi' }] },
                },
          ]
        },
      }),
    )
    await connection.initialize(1000)
    expect(await connection.callTool('echo', { a: 1 }, { timeoutMs: 1000 })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    })
    await expect(connection.callTool('bad', {}, { timeoutMs: 1000 })).rejects.toThrow(
      'MCP error -32602: Unknown tool',
    )
  })

  it('refuses a call result that is not one', async () => {
    const { connection } = connect(
      server({
        call: (message) => [{ jsonrpc: '2.0', id: idOf(message), result: { content: 'x' } }],
      }),
    )
    await connection.initialize(1000)
    await expect(connection.callTool('echo', {}, { timeoutMs: 1000 })).rejects.toThrow(
      'not a tool result',
    )
  })

  it('gives up at the deadline and tells the server the call is off', async () => {
    vi.useFakeTimers()
    try {
      const { transport, connection } = connect(server({ call: () => undefined }))
      await connection.initialize(1000)
      const call = connection.callTool('echo', {}, { timeoutMs: 5000 })
      const settled = expect(call).rejects.toThrow('tools/call timed out after 5 s')
      await vi.advanceTimersByTimeAsync(5000)
      await settled
      expect(transport.sent.at(-1)).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'tools/call timed out after 5 s' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a call on the Stop button, even one stopped before it was sent', async () => {
    const { transport, connection } = connect(server({ call: () => undefined }))
    await connection.initialize(1000)
    const stop = new AbortController()
    const call = connection.callTool('echo', {}, { timeoutMs: 60_000, signal: stop.signal })
    stop.abort()
    await expect(call).rejects.toThrow('the user stopped the turn')
    expect(transport.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled' })
    await expect(
      connection.callTool('echo', {}, { timeoutMs: 60_000, signal: stop.signal }),
    ).rejects.toThrow('the user stopped the turn')
  })

  it('never cancels initialize', async () => {
    vi.useFakeTimers()
    try {
      const { transport, connection } = connect(() => undefined)
      const handshake = expect(connection.initialize(100)).rejects.toThrow('initialize timed out')
      await vi.advanceTimersByTimeAsync(100)
      await handshake
      expect(transport.sent.map((message) => methodOf(message))).toEqual(['initialize'])
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers the server's ping, and refuses what it does not offer", async () => {
    const { transport, connection } = connect(server())
    await connection.initialize(1000)
    transport.deliver({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    transport.deliver({ jsonrpc: '2.0', id: 'p2', method: 'sampling/createMessage' })
    await vi.waitFor(() => {
      expect(transport.sent.slice(-2)).toEqual([
        { jsonrpc: '2.0', id: 'p1', result: {} },
        {
          jsonrpc: '2.0',
          id: 'p2',
          error: { code: -32_601, message: 'Method not found: sampling/createMessage' },
        },
      ])
    })
  })

  it('logs what a message could not deliver, and what the server says', async () => {
    const { transport, connection, log } = connect(server())
    await connection.initialize(1000)
    transport.reply = () => new Error('pipe closed')
    transport.deliver({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    transport.deliver({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'warning', data: { a: 1 } },
    })
    transport.deliver({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'plain' },
    })
    transport.deliver({ jsonrpc: '2.0', method: 'notifications/message', params: 'malformed' })
    transport.deliver({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })
    transport.deliver({ jsonrpc: '1.0', id: 3 })
    transport.deliver([{ jsonrpc: '2.0', id: 99, result: {} }])
    await vi.waitFor(() => {
      expect(countLogged(log, 'was not delivered: pipe closed')).toBeGreaterThan(0)
    })
    expect(countLogged(log, 'MCP server fake (warning): {"a":1}')).toBeGreaterThan(0)
    expect(countLogged(log, 'MCP server fake (info): plain')).toBeGreaterThan(0)
    expect(countLogged(log, 'not JSON-RPC 2.0')).toBeGreaterThan(0)
    expect(countLogged(log, 'not waiting (99)')).toBeGreaterThan(0)
  })

  it('tells its listeners when the tool list changed or the transport ended', async () => {
    const { transport, connection } = connect(server())
    await connection.initialize(1000)
    const changed = vi.fn()
    const ended = vi.fn()
    connection.onToolsChanged(changed)
    connection.onClose(ended)
    transport.deliver({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect(changed).toHaveBeenCalledOnce()
    transport.reply = () => undefined
    const waiting = connection.callTool('echo', {}, { timeoutMs: 60_000 })
    transport.end('exited with code 1')
    transport.end('twice')
    await expect(waiting).rejects.toThrow('the connection closed: exited with code 1')
    expect(ended).toHaveBeenCalledExactlyOnceWith('exited with code 1')
    expect(connection.isOpen).toBe(false)
    await expect(connection.listTools(1000)).rejects.toThrow('the connection closed')
  })

  it('starts a new session once when the server forgot the old one', async () => {
    let isExpired = true
    const base = server()
    const { transport, connection, log } = connect((message) => {
      if (isExpired && methodOf(message) === 'tools/call') {
        isExpired = false
        return new McpSessionExpiredError()
      }
      return base(message)
    })
    await connection.initialize(1000)
    expect(await connection.callTool('echo', {}, { timeoutMs: 1000 })).toEqual({ content: [] })
    expect(transport.sent.map((message) => methodOf(message))).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
    expect(countLogged(log, 'ended its session')).toBeGreaterThan(0)
  })

  it('closes its transport and fails what still waits, telling no listener', async () => {
    const { transport, connection } = connect(server({ call: () => undefined }))
    await connection.initialize(1000)
    const ended = vi.fn()
    connection.onClose(ended)
    const waiting = connection.callTool('echo', {}, { timeoutMs: 60_000 })
    await connection.close()
    await expect(waiting).rejects.toThrow('the client closed it')
    expect(transport.isClosed).toBe(true)
    expect(ended).not.toHaveBeenCalled()
  })
})

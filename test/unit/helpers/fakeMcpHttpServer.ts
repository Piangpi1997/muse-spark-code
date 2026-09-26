// A fake streamable-HTTP MCP server for the Model API backend's MCP tests
// (M50, PLAN.md D42): a real `node:http` server on loopback answering the
// MCP 2025-06-18 transport as a remote server would. Every request is
// recorded. Scripted by options: JSON or event-stream replies, a bearer
// token it insists on, a session id it hands out and a session it forgets
// once, a redirect, a reply too large to read, a stream that never carries
// the answer.

import { Buffer } from 'node:buffer'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

export interface FakeMcpHttpOptions {
  readonly reply?: 'json' | 'sse'
  /** Refuse (401) any request without `Authorization: Bearer <token>`. */
  readonly token?: string
  /** The session id `initialize` hands out. */
  readonly sessionId?: string
  /** Answer the n-th request that carries the session with 404, once. */
  readonly expireAt?: number
  /** Answer every request with a redirect to this URL. */
  readonly redirectTo?: string
  /** `tools/call` answers with a body over MCP_MESSAGE_MAX_BYTES. */
  readonly isHuge?: boolean
  /** An event-stream reply to `tools/call` ends without the answer. */
  readonly isAnswerMissing?: boolean
}

export interface RecordedMcpRequest {
  readonly method: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

export interface FakeMcpHttp {
  readonly url: string
  readonly requests: RecordedMcpRequest[]
  close(): Promise<void>
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'lookup',
    description: 'Reads only',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
]
const OVER_THE_CAP = 21 * 1024 * 1024
const OK = 200
const ACCEPTED = 202
const REDIRECT = 307
const UNAUTHORIZED = 401
const NOT_FOUND = 404

type Message = Readonly<Record<string, unknown>>

/** The value as an object's fields; nothing for anything else. */
function fields(value: unknown): Message {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

function answerTo(message: Message, options: FakeMcpHttpOptions): Message {
  const { id } = message
  const params = fields(message['params'])
  switch (message['method']) {
    case 'initialize': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http', version: '1' },
        },
      }
    }
    case 'tools/list': {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    case 'tools/call': {
      const args = fields(params['arguments'])
      const text =
        options.isHuge === true ? 'x'.repeat(OVER_THE_CAP) : `echo: ${String(args['text'])}`
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
    }
    default: {
      return { jsonrpc: '2.0', id, error: { code: -32_601, message: 'Method not found' } }
    }
  }
}

function sendEvents(response: ServerResponse, messages: readonly Message[]): void {
  response.writeHead(OK, { 'content-type': 'text/event-stream' })
  for (const message of messages) {
    response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }
  response.end()
}

export async function startFakeMcpHttp(options: FakeMcpHttpOptions = {}): Promise<FakeMcpHttp> {
  const requests: RecordedMcpRequest[] = []
  let sessionRequests = 0
  const server = createServer((request, response) => {
    void (async () => {
      const text = await readBody(request)
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      requests.push({ method: request.method ?? '', headers: request.headers, body })
      if (options.redirectTo !== undefined) {
        response.writeHead(REDIRECT, { location: options.redirectTo }).end()
        return
      }
      if (
        options.token !== undefined &&
        request.headers.authorization !== `Bearer ${options.token}`
      ) {
        response.writeHead(UNAUTHORIZED, { 'www-authenticate': 'Bearer realm="fake"' }).end()
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(OK).end()
        return
      }
      if (request.headers['mcp-session-id'] !== undefined) {
        sessionRequests += 1
        if (sessionRequests === options.expireAt) {
          response.writeHead(NOT_FOUND).end()
          return
        }
      }
      const message = fields(body)
      if (message['id'] === undefined || message['method'] === undefined) {
        response.writeHead(ACCEPTED).end()
        return
      }
      const answer = answerTo(message, options)
      const headers =
        message['method'] === 'initialize' && options.sessionId !== undefined
          ? { 'mcp-session-id': options.sessionId }
          : {}
      if (options.reply === 'sse') {
        for (const [name, value] of Object.entries(headers)) {
          response.setHeader(name, value)
        }
        const before: Message[] =
          message['method'] === 'tools/call'
            ? [
                {
                  jsonrpc: '2.0',
                  method: 'notifications/message',
                  params: { level: 'info', data: 'working' },
                },
                { jsonrpc: '2.0', id: 'srv-ping', method: 'ping' },
              ]
            : []
        const isMissing = options.isAnswerMissing === true && message['method'] === 'tools/call'
        sendEvents(response, isMissing ? before : [...before, answer])
        return
      }
      response.writeHead(OK, { 'content-type': 'application/json', ...headers })
      response.end(JSON.stringify(answer))
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

// One MCP client session over a transport (M50, PLAN.md D42): the handshake
// (`initialize`, then `notifications/initialized`), the tool list page by
// page, and tool calls, each request with a deadline and a Stop that tells
// the server it was cancelled (`notifications/cancelled`). What the server
// asks of the client is answered: `ping` with an empty result, anything else
// as a method this client does not offer (it declares no capabilities). Its
// log lines go to the extension's log, and a changed tool list is announced.
// A transport that closes rejects every request still waiting. Pure over the
// transport (stdio.ts, http.ts).

import {
  JSON_RPC_ERRORS,
  MCP_CLIENT_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOLS_LIST_MAX_PAGES,
  MILLISECONDS_PER_SECOND,
} from '../../../../shared/constants'
import { clipForLog, type CoreLogger } from '../../../logging'
import {
  type CallToolResult,
  callToolResultSchema,
  type IncomingMessage,
  incomingMessageSchema,
  initializeResultSchema,
  JSON_RPC_VERSION,
  listToolsResultSchema,
  logMessageSchema,
  McpError,
  type McpToolInfo,
  type OutgoingMessage,
  type RequestId,
  toolInfoSchema,
} from './protocol'

/** How messages travel to and from one server. */
export interface McpTransport {
  /**
   * Sends one message. Over HTTP a request's answer comes back in the reply
   * to this send, and reaches `onMessage` before the promise resolves.
   * Rejects with `McpSessionExpiredError` when the server forgot the session.
   */
  send(message: OutgoingMessage, signal: AbortSignal): Promise<void>
  /** The revision `initialize` agreed on (HTTP sends it with every request). */
  setProtocolVersion(version: string): void
  onMessage(listener: (message: unknown) => void): void
  /** The transport ended (a process exited, a stream failed): once, with the reason. */
  onClose(listener: (reason: string) => void): void
  close(): Promise<void>
}

/** A streamable-HTTP server no longer knows the session (HTTP 404): start a new one. */
export class McpSessionExpiredError extends Error {
  public constructor() {
    super('the server ended the MCP session')
    this.name = 'McpSessionExpiredError'
  }
}

export interface McpConnectionOptions {
  /** The server's name in the settings, for the log. */
  readonly name: string
  readonly clientVersion: string
  readonly log: CoreLogger
}

export interface RequestOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

interface Waiting {
  resolve(result: unknown): void
  reject(error: Error): void
}

const METHOD_INITIALIZE = 'initialize'
const METHOD_PING = 'ping'
const NOTIFICATION_INITIALIZED = 'notifications/initialized'
const NOTIFICATION_CANCELLED = 'notifications/cancelled'
const NOTIFICATION_TOOLS_CHANGED = 'notifications/tools/list_changed'
const NOTIFICATION_LOG = 'notifications/message'
const CANCELLED_BY_USER = 'the user stopped the turn'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seconds(ms: number): string {
  return String(Math.round(ms / MILLISECONDS_PER_SECOND))
}

/** Aborted by the deadline, or by the caller's own signal (the Stop button). */
class RequestAbort extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'McpCancelledError'
  }
}

/** A request that ran out of time; the server was told it is off. */
export class McpTimeoutError extends RequestAbort {
  public constructor(message: string) {
    super(message)
    this.name = 'McpTimeoutError'
  }
}

export class McpConnection {
  private readonly waiting = new Map<RequestId, Waiting>()
  private readonly toolListeners = new Set<() => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private nextId = 0
  private closedReason: string | undefined
  private hasTools = false
  /** The handshake's parameters, kept for a new session after an expired one. */
  private handshakeTimeoutMs = 0

  public constructor(
    private readonly transport: McpTransport,
    private readonly options: McpConnectionOptions,
  ) {
    transport.onMessage((message) => {
      this.receive(message)
    })
    transport.onClose((reason) => {
      this.closed(reason)
    })
  }

  private closed(reason: string): void {
    if (this.closedReason !== undefined) {
      return
    }
    this.closedReason = reason
    for (const waiting of this.waiting.values()) {
      waiting.reject(new McpError(`the connection closed: ${reason}`))
    }
    this.waiting.clear()
    for (const listener of this.closeListeners) {
      listener(reason)
    }
  }

  private receive(raw: unknown): void {
    // Revision 2025-03-26 allowed batches; each member is one message.
    const candidates: readonly unknown[] = Array.isArray(raw) ? raw : [raw]
    for (const candidate of candidates) {
      const parsed = incomingMessageSchema.safeParse(candidate)
      if (!parsed.success) {
        this.options.log.warn(
          `MCP server ${this.options.name} sent a message that is not JSON-RPC 2.0; skipped: ${clipForLog(JSON.stringify(candidate))}`,
        )
        continue
      }
      this.dispatch(parsed.data)
    }
  }

  private dispatch(message: IncomingMessage): void {
    const { id, method } = message
    if (method === undefined) {
      this.settle(message)
      return
    }
    if (id === undefined || id === null) {
      this.notice(method, message.params)
      return
    }
    // A request of the server's own: `ping` is answered; the client offers
    // nothing else (no sampling, roots or elicitation).
    const answer: OutgoingMessage =
      method === METHOD_PING
        ? { jsonrpc: JSON_RPC_VERSION, id, result: {} }
        : {
            jsonrpc: JSON_RPC_VERSION,
            id,
            error: { code: JSON_RPC_ERRORS.methodNotFound, message: `Method not found: ${method}` },
          }
    void this.sendQuietly(answer)
  }

  private settle(message: IncomingMessage): void {
    const { id } = message
    const waiting = id === undefined || id === null ? undefined : this.waiting.get(id)
    if (waiting === undefined) {
      this.options.log.warn(
        `MCP server ${this.options.name} answered a request that is not waiting (${String(id)})`,
      )
      return
    }
    if (message.error === undefined) {
      waiting.resolve(message.result)
      return
    }
    waiting.reject(
      new McpError(
        `MCP error ${String(message.error.code)}: ${message.error.message}`,
        message.error.code,
      ),
    )
  }

  private notice(method: string, params: unknown): void {
    if (method === NOTIFICATION_TOOLS_CHANGED) {
      for (const listener of this.toolListeners) {
        listener()
      }
      return
    }
    // Progress, cancellation and resource notifications need nothing here.
    const parsed = method === NOTIFICATION_LOG ? logMessageSchema.safeParse(params) : undefined
    if (parsed?.success !== true) {
      return
    }
    const { level, data } = parsed.data
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    this.options.log.info(`MCP server ${this.options.name} (${level}): ${clipForLog(text)}`)
  }

  /** A message whose failure is only logged: an answer, a notification after the fact. */
  private async sendQuietly(message: OutgoingMessage): Promise<void> {
    try {
      await this.transport.send(message, new AbortController().signal)
    } catch (error: unknown) {
      this.options.log.warn(
        `A message to MCP server ${this.options.name} was not delivered: ${describe(error)}`,
      )
    }
  }

  /** `send`, starting a new session once when the server forgot the old one. */
  private async sendRenewing(message: OutgoingMessage, signal: AbortSignal): Promise<void> {
    try {
      await this.transport.send(message, signal)
    } catch (error: unknown) {
      if (!(error instanceof McpSessionExpiredError) || !('method' in message)) {
        throw error
      }
      this.options.log.info(
        `MCP server ${this.options.name} ended its session; starting a new one and sending ${message.method} again`,
      )
      await this.handshake(this.handshakeTimeoutMs)
      await this.transport.send(message, signal)
    }
  }

  private async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ): Promise<unknown> {
    if (this.closedReason !== undefined) {
      throw new McpError(`the connection closed: ${this.closedReason}`)
    }
    this.nextId += 1
    const id = this.nextId
    const answered = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
    })
    const controller = new AbortController()
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = controller.signal.reason
          reject(reason instanceof Error ? reason : new Error(String(reason)))
        },
        { once: true },
      )
    })
    const timer = setTimeout(() => {
      controller.abort(
        new McpTimeoutError(`${method} timed out after ${seconds(options.timeoutMs)} s`),
      )
    }, options.timeoutMs)
    const onStop = () => {
      controller.abort(new RequestAbort(CANCELLED_BY_USER))
    }
    if (options.signal?.aborted === true) {
      onStop()
    }
    options.signal?.addEventListener('abort', onStop, { once: true })
    try {
      await Promise.race([
        this.sendRenewing({ jsonrpc: JSON_RPC_VERSION, id, method, params }, controller.signal),
        aborted,
      ])
      return await Promise.race([answered, aborted])
    } catch (error: unknown) {
      // The server is told a request it may still be working on is off;
      // `initialize` is never cancelled (the specification).
      if (method !== METHOD_INITIALIZE && error instanceof RequestAbort) {
        void this.sendQuietly({
          jsonrpc: JSON_RPC_VERSION,
          method: NOTIFICATION_CANCELLED,
          params: { requestId: id, reason: error.message },
        })
      }
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onStop)
      this.waiting.delete(id)
    }
  }

  private async handshake(timeoutMs: number): Promise<void> {
    const raw = await this.request(
      METHOD_INITIALIZE,
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: this.options.clientVersion },
      },
      { timeoutMs },
    )
    const parsed = initializeResultSchema.safeParse(raw)
    if (!parsed.success) {
      throw new McpError('initialize was answered with something that is not an initialize result')
    }
    const { protocolVersion, capabilities } = parsed.data
    if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
      throw new McpError(
        `the server speaks MCP ${protocolVersion}; this client speaks ${[...MCP_SUPPORTED_PROTOCOL_VERSIONS].join(', ')}`,
      )
    }
    this.transport.setProtocolVersion(protocolVersion)
    this.hasTools = capabilities.tools !== undefined
    await this.transport.send(
      { jsonrpc: JSON_RPC_VERSION, method: NOTIFICATION_INITIALIZED },
      new AbortController().signal,
    )
  }

  /** The handshake; rejects when the server cannot be spoken to. */
  public async initialize(timeoutMs: number): Promise<void> {
    this.handshakeTimeoutMs = timeoutMs
    await this.handshake(timeoutMs)
  }

  /** Every tool the server lists, page by page; a malformed tool is skipped and logged. */
  public async listTools(timeoutMs: number): Promise<readonly McpToolInfo[]> {
    if (!this.hasTools) {
      return []
    }
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < MCP_TOOLS_LIST_MAX_PAGES; page += 1) {
      const raw = await this.request('tools/list', cursor === undefined ? {} : { cursor }, {
        timeoutMs,
      })
      const parsed = listToolsResultSchema.safeParse(raw)
      if (!parsed.success) {
        throw new McpError('tools/list was answered without a list of tools')
      }
      for (const candidate of parsed.data.tools) {
        const tool = toolInfoSchema.safeParse(candidate)
        if (tool.success) {
          tools.push(tool.data)
        } else {
          this.options.log.warn(
            `MCP server ${this.options.name} listed a tool without a name or with a malformed schema; skipped: ${clipForLog(JSON.stringify(candidate))}`,
          )
        }
      }
      cursor = parsed.data.nextCursor ?? undefined
      if (cursor === undefined || cursor === '') {
        return tools
      }
    }
    this.options.log.warn(
      `MCP server ${this.options.name} lists more than ${String(MCP_TOOLS_LIST_MAX_PAGES)} pages of tools; the rest are not read`,
    )
    return tools
  }

  /** Calls one tool; rejects on a JSON-RPC error, the deadline, a Stop or a closed connection. */
  public async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ): Promise<CallToolResult> {
    const raw = await this.request('tools/call', { name, arguments: args }, options)
    const parsed = callToolResultSchema.safeParse(raw)
    if (!parsed.success) {
      throw new McpError('tools/call was answered with something that is not a tool result')
    }
    return parsed.data
  }

  /** The server said its tool list changed (`notifications/tools/list_changed`). */
  public onToolsChanged(listener: () => void): void {
    this.toolListeners.add(listener)
  }

  /** The connection ended by itself (the process exited, the stream failed). */
  public onClose(listener: (reason: string) => void): void {
    this.closeListeners.add(listener)
  }

  public get isOpen(): boolean {
    return this.closedReason === undefined
  }

  /** Closes the transport; whatever still waits is rejected. Listeners are not told. */
  public async close(): Promise<void> {
    this.closeListeners.clear()
    this.toolListeners.clear()
    this.closed('the client closed it')
    await this.transport.close()
  }
}

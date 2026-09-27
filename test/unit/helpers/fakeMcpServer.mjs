#!/usr/bin/env node
// A fake stdio MCP server for the Model API backend's MCP tests (M50,
// PLAN.md D42): the MCP 2025-06-18 server side over stdin and stdout, one
// JSON-RPC message per line (or Content-Length framed), started as a real
// child process by the host's spawner. Node built-ins only.
//
// Environment (set through the server's `env` in the test's settings):
//   FAKE_MCP_FRAMING=content_length  LSP-style headers instead of lines
//   FAKE_MCP_START=crash             exit 3 before the handshake, with a reason on stderr
//   FAKE_MCP_START=silent            read everything, answer nothing
//   FAKE_MCP_START=banner            print a line that is not JSON to stdout first
//   FAKE_MCP_VERSION=<revision>      answer `initialize` with this revision
//   FAKE_MCP_IGNORE_EOF=1            stay when stdin closes (the kill drill)
//
// Tools: echo {text}, picture (an image and a line of text), broken
// (isError), env (the environment names and the working directory), wait
// {ms} (answers after ms; a cancellation is logged and never answered),
// grow (adds a tool and says the list changed), lookup (read-only), die
// (exits 7 mid-call), ping_client (pings the client first). Listed two a
// page.

import { Buffer } from 'node:buffer'
import { writeSync } from 'node:fs'
import { cwd, env, exit, stderr, stdin, stdout } from 'node:process'
import { clearTimeout, setInterval, setTimeout } from 'node:timers'

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const METHOD_NOT_FOUND = -32_601
const INVALID_PARAMS = -32_602
const CRASH_EXIT_CODE = 3
const DIE_EXIT_CODE = 7
const PAGE_SIZE = 2
const LINE_FEED = 10
const KEEP_ALIVE_MS = 60_000
const HEADER_END = '\r\n\r\n'
const isContentLength = env['FAKE_MCP_FRAMING'] === 'content_length'
const start = env['FAKE_MCP_START'] ?? 'normal'

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  { name: 'picture', description: 'A picture', inputSchema: { type: 'object' } },
  { name: 'broken', description: 'Always fails', inputSchema: { type: 'object' } },
  { name: 'env', description: 'What the server was started with', inputSchema: { type: 'object' } },
  {
    name: 'wait',
    description: 'Answers after a while',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  { name: 'grow', description: 'Adds a tool', inputSchema: { type: 'object' } },
  {
    name: 'lookup',
    description: 'Reads only',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
  { name: 'die', description: 'Exits', inputSchema: { type: 'object' } },
  { name: 'ping_client', description: 'Pings the client', inputSchema: { type: 'object' } },
]
const state = {
  /** Calls still waiting, by request id: a cancellation drops them. */
  waiting: new Map(),
  /** Requests this server sent the client, by id, with the call they belong to. */
  asked: new Map(),
  /** Bytes read but not yet a whole message. */
  pending: Buffer.alloc(0),
}

stderr.write('fake mcp: started\n')
if (start === 'crash') {
  stderr.write('fake mcp: refusing to start\n')
  exit(CRASH_EXIT_CODE)
} else if (start === 'banner') {
  stdout.write('Fake MCP server listening on stdio\n')
}

function send(message) {
  const json = JSON.stringify(message)
  if (isContentLength) {
    stdout.write(`Content-Length: ${String(Buffer.byteLength(json))}${HEADER_END}${json}`)
  } else {
    stdout.write(`${json}\n`)
  }
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError && { isError: true }) }
}

function wait(id, ms) {
  const timer = setTimeout(() => {
    state.waiting.delete(id)
    result(id, textResult('waited'))
  }, ms)
  state.waiting.set(id, timer)
}

function callTool(id, params) {
  const args = params.arguments ?? {}
  switch (params.name) {
    case 'echo': {
      result(id, textResult(`echo: ${String(args.text)}`))
      break
    }
    case 'picture': {
      result(id, {
        content: [
          { type: 'text', text: 'a dot' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
        ],
      })
      break
    }
    case 'broken': {
      result(id, textResult('it broke', true))
      break
    }
    case 'env': {
      const names = Object.keys(env).toSorted((a, b) => a.localeCompare(b))
      result(id, textResult(JSON.stringify({ names, cwd: cwd() })))
      break
    }
    case 'wait': {
      wait(id, Number(args.ms ?? 0))
      break
    }
    case 'grow': {
      tools.push({ name: 'extra', description: 'Added later', inputSchema: { type: 'object' } })
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      result(id, textResult('grown'))
      break
    }
    case 'lookup': {
      result(id, textResult('found'))
      break
    }
    case 'die': {
      stderr.write('fake mcp: dying\n')
      exit(DIE_EXIT_CODE)
      break
    }
    case 'final_then_exit': {
      const json = JSON.stringify({ jsonrpc: '2.0', id, result: textResult('final reply') })
      const frame = isContentLength
        ? `Content-Length: ${String(Buffer.byteLength(json))}${HEADER_END}${json}`
        : `${json}\n`
      writeSync(1, Buffer.from(frame))
      exit(0)
      break
    }
    case 'ping_client': {
      state.asked.set('srv-1', id)
      send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' })
      break
    }
    default: {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(params.name)}` },
      })
    }
  }
}

function listTools(id, params) {
  const offset = Number(params?.cursor ?? 0)
  const page = tools.slice(offset, offset + PAGE_SIZE)
  const next = offset + PAGE_SIZE
  result(id, { tools: page, ...(next < tools.length && { nextCursor: String(next) }) })
}

/** An answer to this server's own request (ping_client). */
function answered(message) {
  const callId = state.asked.get(message.id)
  state.asked.delete(message.id)
  if (callId !== undefined) {
    result(callId, textResult(message.error === undefined ? 'pong received' : 'ping refused'))
  }
}

function notified(method, params) {
  if (method === 'notifications/cancelled') {
    clearTimeout(state.waiting.get(params.requestId))
    state.waiting.delete(params.requestId)
    stderr.write(`fake mcp: cancelled ${String(params.requestId)}\n`)
  } else if (method === 'notifications/initialized') {
    send({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'ready' },
    })
  }
}

function handle(message) {
  const { id, method, params } = message
  if (start === 'silent') {
    return
  }
  if (method === undefined) {
    answered(message)
    return
  }
  if (id === undefined) {
    notified(method, params)
    return
  }
  switch (method) {
    case 'initialize': {
      result(id, {
        protocolVersion: env['FAKE_MCP_VERSION'] ?? params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      })
      break
    }
    case 'tools/list': {
      listTools(id, params)
      break
    }
    case 'tools/call': {
      callTool(id, params)
      break
    }
    default: {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      })
    }
  }
}

/** The next whole message read, taken off the pending bytes; none while it is incomplete. */
function nextMessage() {
  const { pending } = state
  if (!isContentLength) {
    const newline = pending.indexOf(LINE_FEED)
    if (newline === -1) {
      return
    }
    state.pending = pending.subarray(newline + 1)
    return pending.subarray(0, newline).toString('utf8')
  }
  const headerEnd = pending.indexOf(HEADER_END)
  if (headerEnd === -1) {
    return
  }
  const header = pending.subarray(0, headerEnd).toString('latin1')
  const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
  const bodyStart = headerEnd + HEADER_END.length
  if (pending.length < bodyStart + length) {
    return
  }
  state.pending = pending.subarray(bodyStart + length)
  return pending.subarray(bodyStart, bodyStart + length).toString('utf8')
}

stdin.on('data', (chunk) => {
  state.pending = Buffer.concat([state.pending, chunk])
  for (let frame = nextMessage(); frame !== undefined; frame = nextMessage()) {
    if (frame.trim() !== '') {
      handle(JSON.parse(frame))
    }
  }
})
stdin.on('end', () => {
  if (env['FAKE_MCP_IGNORE_EOF'] !== '1') {
    exit(0)
  }
})
// Keeps the process alive while it ignores the end of its input.
setInterval(() => {
  stderr.write('')
}, KEEP_ALIVE_MS)

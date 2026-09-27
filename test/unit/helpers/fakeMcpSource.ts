// An MCP server set in memory for the Model API host's tests (M50): the
// tools it offers, what their calls answer, the state its snapshot shows,
// and a record of what the host asked of it.

import type { McpCallOutcome } from '../../../src/core/backends/modelapi/mcp/functions'
import type {
  McpPoolSnapshot,
  McpToolRef,
  McpToolSource,
} from '../../../src/core/backends/modelapi/mcp/pool'

export interface FakeMcpTool {
  readonly server: string
  readonly tool: string
  readonly isReadOnly?: boolean
}

export interface FakeMcpSource extends McpToolSource {
  readonly calls: { readonly name: string; readonly args: string }[]
  /** What the next calls answer (or throw), in order; the last one repeats. */
  outcomes: (McpCallOutcome | Error)[]
  snapshotValue: McpPoolSnapshot
  starts: number
  isClosed: boolean
  /** A call waits for this before it answers, when set. */
  gate: Promise<void> | undefined
}

const functionName = (tool: FakeMcpTool) => `mcp__${tool.server}__${tool.tool}`

export function fakeMcpSource(
  tools: readonly FakeMcpTool[],
  snapshot: Partial<McpPoolSnapshot> = {},
): FakeMcpSource {
  const source: FakeMcpSource = {
    calls: [],
    outcomes: [{ output: 'mcp ok', visibleOutput: 'mcp ok' }],
    snapshotValue: { isStarted: true, fault: undefined, servers: [], ...snapshot },
    starts: 0,
    isClosed: false,
    gate: undefined,
    start: () => {
      source.starts += 1
      return Promise.resolve()
    },
    snapshot: () => source.snapshotValue,
    definitions: () =>
      tools.map((tool) => ({
        type: 'function',
        name: functionName(tool),
        description: `${tool.tool} of ${tool.server}`,
        parameters: { type: 'object' },
        strict: false,
      })),
    find: (name): McpToolRef | undefined => {
      const tool = tools.find((candidate) => functionName(candidate) === name)
      return tool === undefined
        ? undefined
        : { server: tool.server, tool: tool.tool, isReadOnly: tool.isReadOnly === true }
    },
    call: async (name, args, signal) => {
      source.calls.push({ name, args })
      if (source.gate !== undefined) {
        await Promise.race([
          source.gate,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('stopped'))
            })
          }),
        ])
      }
      const outcome = source.outcomes.length > 1 ? source.outcomes.shift() : source.outcomes[0]
      if (outcome === undefined || outcome instanceof Error) {
        throw outcome ?? new Error('no outcome')
      }
      return outcome
    },
    close: () => {
      source.isClosed = true
      return Promise.resolve()
    },
  }
  return source
}

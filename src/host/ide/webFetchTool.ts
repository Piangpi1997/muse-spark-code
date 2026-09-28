// Web fetch for Muse Code through the `ide` session server (M69, PLAN.md
// D49): Muse Code's own `web_fetch` is switched off in `muse serve`, so the
// extension fetches the page itself (webFetcher.ts) and hands its text back.
// The server is one loopback endpoint for the whole window, with no session
// identity, and it is attached even in Restricted Mode, so the tool:
//
// - is listed only while the workspace is trusted and
//   `museSpark.sandboxNetwork` does not deny the agent the network (the list
//   is read on every request, so a call made after either changes finds no
//   such tool);
// - declares itself open-world and not read-only (MCP annotations), so Muse
//   Code's own approval treats it as more than a read;
// - asks in the extension's own modal before every call, naming the host
//   and the URL, whatever mode Muse Code runs in, as the image tools do.
//
// Nothing is billed: the fetch is the extension's, not Meta's paid search.

import * as z from 'zod/mini'
import type { McpTool } from '../../core/mcp'
import { WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS } from '../../core/web/webFetchDefinition'
import type { WebFetcher } from '../../core/web/webFetch'
import { checkPageUrl } from '../../core/web/pageUrl'
import {
  IDE_WEB_FETCH_TOOL,
  MCP_ANNOTATIONS_OPEN_WORLD,
  MODEL_TEXT,
  SANDBOX_NETWORK_DENIED,
  type SandboxNetworkMode,
} from '../../shared/constants'
import type { Logger } from '../logger'

export interface IdeWebFetchDeps {
  /** A trusted workspace whose sandbox network setting allows the network. */
  readonly isOffered: () => boolean
  readonly fetchPage: WebFetcher
  /** The modal before every fetch: true only when the user allowed this one. */
  readonly confirm: (url: string, host: string) => Promise<boolean>
  readonly log: Logger
}

const argsSchema = z.object({ url: z.string() })

/**
 * Whether Muse Code is offered the fetch: a trusted workspace, and
 * `museSpark.sandboxNetwork` not set to deny its commands the network.
 */
export function isIdeWebFetchOffered(
  isTrusted: boolean,
  sandboxNetwork: SandboxNetworkMode,
): boolean {
  return isTrusted && sandboxNetwork !== SANDBOX_NETWORK_DENIED
}

async function callWebFetch(
  args: Readonly<Record<string, unknown>>,
  deps: IdeWebFetchDeps,
): Promise<string> {
  const parsed = argsSchema.safeParse(args)
  if (!parsed.success) {
    throw new Error(`invalid arguments: ${z.prettifyError(parsed.error)}`)
  }
  // A URL that would be refused anyway is refused before the modal.
  const checked = checkPageUrl(parsed.data.url)
  if (!checked.ok) {
    throw new Error(checked.failure.reason)
  }
  if (!(await deps.confirm(checked.url.href, checked.url.host))) {
    deps.log.info(`Web fetch from ${checked.url.host} declined in the extension's confirmation`)
    throw new Error(MODEL_TEXT.webFetchDeclined)
  }
  // No turn to stop it from here: the fetch's own deadline ends the wait.
  const result = await deps.fetchPage(checked.url.href, new AbortController().signal)
  if (result.kind === 'failed') {
    throw new Error(result.failure.reason)
  }
  return result.text
}

/** The tool as it stands now: none while the workspace is untrusted or the network is denied. */
export function ideWebFetchTools(deps: IdeWebFetchDeps): readonly McpTool[] {
  if (!deps.isOffered()) {
    return []
  }
  return [
    {
      name: IDE_WEB_FETCH_TOOL,
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: WEB_FETCH_PARAMETERS,
        required: ['url'],
        additionalProperties: false,
      },
      annotations: MCP_ANNOTATIONS_OPEN_WORLD,
      call: async (args) => await callWebFetch(args, deps),
    },
  ]
}

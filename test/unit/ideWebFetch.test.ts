// Web fetch for Muse Code through the `ide` session server (M69, PLAN.md
// D49): listed only while offered (a trusted workspace whose sandbox network
// setting allows the network), declared open-world and not read-only, and
// confirmed in the extension's own modal before every call.
import { describe, expect, it } from 'vitest'
import { handleMcpMessage } from '../../src/core/mcp'
import type { WebFetcher, WebFetchResult } from '../../src/core/web/webFetch'
import { webFetchFailure } from '../../src/core/web/fetchFailure'
import { ideWebFetchTools, isIdeWebFetchOffered } from '../../src/host/ide/webFetchTool'
import { IDE_MCP_SERVER_INFO, MODEL_TEXT } from '../../src/shared/constants'
import { FakeLogOutputChannel } from './helpers/fakes'

// The same page over plain HTTP, which the fetch refuses.
const PLAIN_HTTP = 'https://docs.example.com/'.replace('https:', 'http:')

const PAGE: WebFetchResult = {
  kind: 'page',
  page: {
    url: 'https://docs.example.com/',
    finalUrl: 'https://docs.example.com/',
    status: 200,
    type: 'text/html',
    bytes: 10,
  },
  text: 'Fetched https://docs.example.com/ (HTTP 200, text/html, 10 bytes).',
}

function setup(options: { isOffered?: boolean; answer?: boolean; result?: WebFetchResult } = {}) {
  const asked: { url: string; host: string }[] = []
  const fetched: string[] = []
  let isOffered = options.isOffered ?? true
  const fetchPage: WebFetcher = (url) => {
    fetched.push(url)
    return Promise.resolve(options.result ?? PAGE)
  }
  const tools = () =>
    ideWebFetchTools({
      isOffered: () => isOffered,
      fetchPage,
      confirm: (url, host) => {
        asked.push({ url, host })
        return Promise.resolve(options.answer ?? true)
      },
      log: new FakeLogOutputChannel(),
    })
  const call = async (args: Record<string, unknown>) => {
    const tool = tools().find((candidate) => candidate.name === 'webFetch')
    if (tool === undefined) {
      throw new Error('webFetch is not listed')
    }
    return await tool.call(args)
  }
  return {
    asked,
    fetched,
    tools,
    call,
    offer: (isNowOffered: boolean) => {
      isOffered = isNowOffered
    },
  }
}

describe('the ide server web fetch (M69)', () => {
  it('is offered only in a trusted workspace whose sandbox network setting allows it', () => {
    expect(isIdeWebFetchOffered(true, 'default')).toBe(true)
    expect(isIdeWebFetchOffered(true, 'proxy-only')).toBe(true)
    expect(isIdeWebFetchOffered(true, 'enabled')).toBe(true)
    expect(isIdeWebFetchOffered(true, 'restricted')).toBe(false)
    expect(isIdeWebFetchOffered(false, 'enabled')).toBe(false)
  })

  it('is listed only while offered, with open-world annotations', async () => {
    const t = setup()
    const listed = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      t.tools(),
      IDE_MCP_SERVER_INFO,
    )
    expect(listed).toMatchObject({
      body: {
        result: {
          tools: [
            {
              name: 'webFetch',
              annotations: { readOnlyHint: false, openWorldHint: true },
              inputSchema: { required: ['url'] },
            },
          ],
        },
      },
    })
    t.offer(false)
    expect(t.tools()).toEqual([])
    // A call made after the workspace lost its trust finds no such tool.
    const called = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'webFetch', arguments: { url: 'https://docs.example.com/' } },
      }),
      t.tools(),
      IDE_MCP_SERVER_INFO,
    )
    expect(called).toMatchObject({ body: { result: { isError: true } } })
    expect(t.fetched).toEqual([])
  })

  it('asks before every fetch, naming the host, and fetches only what was allowed', async () => {
    const t = setup()
    expect(await t.call({ url: 'https://Docs.Example.com/guide#part' })).toBe(PAGE.text)
    expect(await t.call({ url: 'https://docs.example.com/other' })).toBe(PAGE.text)
    expect(t.asked).toEqual([
      { url: 'https://docs.example.com/guide', host: 'docs.example.com' },
      { url: 'https://docs.example.com/other', host: 'docs.example.com' },
    ])
    expect(t.fetched).toEqual(['https://docs.example.com/guide', 'https://docs.example.com/other'])
  })

  it('fetches nothing the user declined, or that is refused before the question', async () => {
    const declined = setup({ answer: false })
    await expect(declined.call({ url: 'https://docs.example.com/' })).rejects.toThrow(
      MODEL_TEXT.webFetchDeclined,
    )
    expect(declined.fetched).toEqual([])
    const t = setup()
    await expect(t.call({ url: 'https://169.254.169.254/' })).rejects.toThrow(/not a public/)
    await expect(t.call({ url: PLAIN_HTTP })).rejects.toThrow(MODEL_TEXT.webFetchNotHttps)
    await expect(t.call({ link: 'x' })).rejects.toThrow(/invalid arguments/)
    expect(t.asked).toEqual([])
    expect(t.fetched).toEqual([])
  })

  it("reports the fetch's own refusal as a tool error", async () => {
    const t = setup({
      result: { kind: 'failed', failure: webFetchFailure('contentType', { type: 'image/png' }) },
    })
    await expect(t.call({ url: 'https://docs.example.com/logo.png' })).rejects.toThrow('image/png')
  })
})

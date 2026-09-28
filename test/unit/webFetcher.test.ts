import { describe, expect, it } from 'vitest'
import { createWebFetcher } from '../../src/host/web/webFetcher'
import { FakeLogOutputChannel } from './helpers/fakes'
import { logLines } from './helpers/logText'

describe("the window's web fetch (M69)", () => {
  it('logs the host and the outcome, never the path or the query', async () => {
    const log = new FakeLogOutputChannel()
    const fetchPage = createWebFetcher(log)
    const result = await fetchPage(
      'https://localhost:8443/private/path?token=abc',
      new AbortController().signal,
    )
    expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'reservedHost' } })
    await fetchPage('not a url', new AbortController().signal)
    expect(logLines(log)).toEqual([
      'Web fetch from localhost:8443: refused or failed: reservedHost',
      'Web fetch from (not a URL): refused or failed: invalidUrl',
    ])
  })
})

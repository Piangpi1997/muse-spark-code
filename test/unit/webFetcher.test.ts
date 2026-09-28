import { describe, expect, it } from 'vitest'
import { createWebFetcher, discoverNat64 } from '../../src/host/web/webFetcher'
import { FakeLogOutputChannel } from './helpers/fakes'
import { logLines } from './helpers/logText'

describe("the window's web fetch (M69)", () => {
  it('logs the host and the outcome, never the path or the query', async () => {
    const log = new FakeLogOutputChannel()
    const fetchPage = createWebFetcher(log, () => Promise.resolve([]))
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

  it("reads the network's NAT64 prefix from ipv4only.arpa, and none where DNS64 is absent", async () => {
    const log = new FakeLogOutputChannel()
    expect(
      await discoverNat64(() => Promise.resolve(['2a01:4f8:c0c:1234:c0:0:aa00:0']), log),
    ).toEqual([{ prefix: 0x2a_01_04_f8_0c_0c_12_34n, length: 64 }])
    const absent = await discoverNat64(
      () => Promise.reject(Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' })),
      log,
    )
    expect(absent).toEqual([])
    expect(logLines(log)).toEqual(['Web fetch: no NAT64 prefix from ipv4only.arpa (ENODATA)'])
  })
})

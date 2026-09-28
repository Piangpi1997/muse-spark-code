import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HtmlJob } from '../../src/core/web/htmlConversion'
import { pageConverter } from '../../src/host/web/pageConverter'

// The worker's own bundle, built as `npm run build` builds dist/pageWorker.js.
const dir = mkdtempSync(path.join(tmpdir(), 'muse-page-worker-'))
const workerPath = path.join(dir, 'pageWorker.js')
const NOT_STOPPED = new AbortController().signal
const SHORT = { timeoutMs: 500, maxHeapMib: 512 }

beforeAll(async () => {
  await build({
    entryPoints: ['src/host/web/pageWorker.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  })
}, 60_000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function job(html: string): HtmlJob {
  return {
    bytes: new Uint8Array(Buffer.from(html, 'utf8')),
    charset: undefined,
    url: 'https://docs.example.com/guide/',
    maxChars: 100_000,
  }
}

/** A stand-in worker script: what the real one must never do. */
function fakeWorker(name: string, source: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, source)
  return file
}

describe("web fetch's page converter on a worker thread (M69)", () => {
  it('converts a page on the worker, from its bytes', async () => {
    const outcome = await pageConverter(workerPath)(
      job('<title>Guide</title><p>Hello <b>you</b> <a href="next">on</a>'),
      NOT_STOPPED,
    )
    expect(outcome).toEqual({
      ok: true,
      page: {
        title: 'Guide',
        markdown: 'Hello **you** [on](https://docs.example.com/guide/next)',
        isTruncated: false,
      },
    })
  })

  it('stops a page nested to be slow to parse at the time limit', async () => {
    const started = performance.now()
    const outcome = await pageConverter(workerPath, SHORT)(
      job('<ul><li>'.repeat(40_000)),
      NOT_STOPPED,
    )
    expect(outcome).toEqual({ ok: false, kind: 'timeout', detail: '500' })
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('stops a converter that passes its heap limit', async () => {
    const hog = fakeWorker(
      'hog.js',
      'const kept = []; for (;;) { kept.push(new Array(1_000_000).fill(kept.length)) }',
    )
    const outcome = await pageConverter(hog, { timeoutMs: 20_000, maxHeapMib: 32 })(
      job('<p>x'),
      NOT_STOPPED,
    )
    expect(outcome).toEqual({ ok: false, kind: 'memory', detail: 'ERR_WORKER_OUT_OF_MEMORY' })
  })

  it('refuses the page when the converter cannot load, or answers in another shape', async () => {
    const missing = await pageConverter(path.join(dir, 'missing.js'))(job('<p>x'), NOT_STOPPED)
    expect(missing).toMatchObject({ ok: false, kind: 'failed' })
    const odd = fakeWorker(
      'odd.js',
      "require('node:worker_threads').parentPort.postMessage({ ok: true, page: 7 })",
    )
    expect(await pageConverter(odd)(job('<p>x'), NOT_STOPPED)).toEqual({
      ok: false,
      kind: 'failed',
      detail: 'the converter answered in an unknown shape',
    })
  })

  it('stops with the fetch', async () => {
    const stop = new AbortController()
    const converting = pageConverter(workerPath)(job('<ul><li>'.repeat(40_000)), stop.signal)
    stop.abort()
    expect(await converting).toEqual({ ok: false, kind: 'failed', detail: 'stopped' })
    const stopped = new AbortController()
    stopped.abort()
    expect(await pageConverter(workerPath)(job('<p>x'), stopped.signal)).toEqual({
      ok: false,
      kind: 'failed',
      detail: 'stopped',
    })
  })
})

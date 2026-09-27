import { expect, it, vi } from 'vitest'
import { ModelApiClient } from '../../src/core/backends/modelapi/client'
import { prepareImageCall, runImageCall } from '../../src/core/backends/modelapi/imageGeneration'
import { FakeLogOutputChannel } from './helpers/fakes'
import { memoryToolIo } from './helpers/fakeToolIo'

it('prepares a paid image edit from the checked target after a source link retargets', async () => {
  const base = memoryToolIo({}, '/ws')
  const inside = new Uint8Array([1, 2, 3])
  const outside = new Uint8Array([4, 5, 6])
  base.binaries.set('/ws/safe/source.png', inside)
  base.binaries.set('/ws/outside/source.png', outside)
  let target = '/ws/safe'
  const io = {
    ...base,
    realPath: (absolutePath: string) => {
      if (absolutePath !== '/ws/link/source.png') {
        return Promise.resolve(absolutePath)
      }
      const checked = `${target}/source.png`
      target = '/ws/outside'
      return Promise.resolve(checked)
    },
    readBytes: (absolutePath: string, maxBytes: number) =>
      base.readBytes(
        absolutePath === '/ws/link/source.png' ? `${target}/source.png` : absolutePath,
        maxBytes,
      ),
  }
  const result = await prepareImageCall(
    'edit',
    { prompt: 'edit', images: ['link/source.png'], path: 'edited.png' },
    { workspaceRoot: '/ws', platform: 'linux', io },
  )
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.reason)
  }
  expect(result.plan.sources[0]?.bytes).toEqual(inside)
  expect(result.plan.sources[0]?.bytes).not.toEqual(outside)
  // prepareImageCall is the pre-confirmation stage: no paid API call occurs here.
})

it('reserves paid image output at the checked target after a link retargets, before any request', async () => {
  const base = memoryToolIo({}, '/ws')
  const reserved: string[] = []
  const io = {
    ...base,
    realPath: (absolutePath: string) =>
      Promise.resolve(
        absolutePath === '/ws/link/output.png' ? '/ws/safe/output.png' : absolutePath,
      ),
    pathExists: (absolutePath: string) =>
      base.pathExists(absolutePath === '/ws/link/output.png' ? '/etc/output.png' : absolutePath),
    reserveFile: (absolutePath: string) => {
      reserved.push(absolutePath === '/ws/link/output.png' ? '/etc/output.png' : absolutePath)
      return Promise.reject(new Error('EEXIST'))
    },
  }
  const prepared = await prepareImageCall(
    'generate',
    { prompt: 'draw', path: 'link/output.png' },
    { workspaceRoot: '/ws', platform: 'linux', io },
  )
  if (!prepared.ok) {
    throw new Error(prepared.reason)
  }
  const request = vi.fn<() => Promise<Response>>(() => Promise.reject(new Error('paid request')))
  const client = new ModelApiClient({
    fetch: request,
    baseUrl: 'https://api.example.test/v1',
    apiKey: () => Promise.resolve(undefined),
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0,
    log: new FakeLogOutputChannel(),
  })
  const billed = vi.fn()
  const result = await runImageCall(prepared.plan, {
    client,
    io,
    signal: new AbortController().signal,
    isStillOn: () => true,
    onBilled: billed,
  })
  expect(result.failureReason).toBeDefined()
  expect(reserved).toEqual(['/ws/safe/output.png'])
  expect(request).not.toHaveBeenCalled()
  expect(billed).not.toHaveBeenCalled()
})

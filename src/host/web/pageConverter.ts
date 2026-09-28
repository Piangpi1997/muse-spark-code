// Runs web fetch's HTML converter on a worker thread (M69, PLAN.md D49):
// the bundled dist/pageWorker.js, loaded only when a page is converted. The
// worker is stopped when it passes WEB_FETCH_CONVERT_TIMEOUT_MS, when its
// heap passes WEB_FETCH_CONVERT_MAX_HEAP_MIB, or when the fetch is stopped;
// the extension host itself never parses a page. A worker that cannot be
// started (its bundle missing) refuses the page with the reason.

import { Worker } from 'node:worker_threads'
import * as z from 'zod/mini'
import type { HtmlConversion, HtmlConverter, HtmlJob } from '../../core/web/htmlConversion'
import {
  WEB_FETCH_CONVERT_MAX_HEAP_MIB,
  WEB_FETCH_CONVERT_TIMEOUT_MS,
} from '../../shared/constants'

// Node's code for a worker stopped at its heap limit.
const OUT_OF_MEMORY = 'ERR_WORKER_OUT_OF_MEMORY'
const STOPPED = 'stopped'

// What the worker posts, checked at the thread boundary (AGENTS.md rule 7).
const CONVERSION = z.union([
  z.object({
    ok: z.literal(true),
    page: z.object({
      title: z.optional(z.string()),
      markdown: z.string(),
      isTruncated: z.boolean(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(['timeout', 'memory', 'failed']),
    detail: z.string(),
  }),
])

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'error'
}

/** How long, and with how much heap, a page may take to convert. */
interface ConverterLimits {
  readonly timeoutMs: number
  readonly maxHeapMib: number
}

const LIMITS: ConverterLimits = {
  timeoutMs: WEB_FETCH_CONVERT_TIMEOUT_MS,
  maxHeapMib: WEB_FETCH_CONVERT_MAX_HEAP_MIB,
}

/** The converter on the worker bundle at `workerPath`, with the time and memory limits. */
export function pageConverter(workerPath: string, limits = LIMITS): HtmlConverter {
  return async (job, signal) => await convertOnWorker(workerPath, job, limits, signal)
}

function convertOnWorker(
  workerPath: string,
  job: HtmlJob,
  limits: ConverterLimits,
  signal: AbortSignal,
): Promise<HtmlConversion> {
  const { timeoutMs, maxHeapMib } = limits
  return new Promise<HtmlConversion>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(workerPath, {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMib },
      })
    } catch (error: unknown) {
      resolve({ ok: false, kind: 'failed', detail: codeOf(error) })
      return
    }
    let isSettled = false
    const settle = (outcome: HtmlConversion) => {
      if (isSettled) {
        return
      }
      isSettled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      void worker.terminate()
      resolve(outcome)
    }
    function onAbort(): void {
      settle({ ok: false, kind: 'failed', detail: STOPPED })
    }
    const timer = setTimeout(() => {
      settle({ ok: false, kind: 'timeout', detail: String(timeoutMs) })
    }, timeoutMs)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: unknown) => {
      const parsed = CONVERSION.safeParse(message)
      if (!parsed.success) {
        settle({ ok: false, kind: 'failed', detail: 'the converter answered in an unknown shape' })
        return
      }
      const outcome = parsed.data
      settle(
        outcome.ok ? { ok: true, page: { ...outcome.page, title: outcome.page.title } } : outcome,
      )
    })
    worker.on('error', (error: unknown) => {
      const code = codeOf(error)
      settle({ ok: false, kind: code === OUT_OF_MEMORY ? 'memory' : 'failed', detail: code })
    })
    worker.on('exit', (code: number) => {
      settle({
        ok: false,
        kind: 'failed',
        detail: `the converter exited with code ${String(code)}`,
      })
    })
  })
}

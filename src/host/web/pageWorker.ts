// Web fetch's HTML converter on a worker thread (M69, PLAN.md D49), a bundle
// of its own (dist/pageWorker.js): parse5 and the converter load only when a
// page is converted, never at activation, and the extension host can stop
// the thread (pageConverter.ts) when a page built to be slow or large to
// parse passes its time or memory limit. One page per worker.

import { parentPort, workerData } from 'node:worker_threads'
import * as z from 'zod/mini'
import type { HtmlConversion } from '../../core/web/htmlConversion'
import { convertHtmlJob } from '../../core/web/htmlToMarkdown'

// The job crosses a thread boundary, so it is parsed like any other message
// (AGENTS.md rule 7), although only pageConverter.ts sends it.
const JOB = z.object({
  bytes: z.instanceof(Uint8Array),
  charset: z.optional(z.string()),
  url: z.string(),
  maxChars: z.number(),
})

function convert(): HtmlConversion {
  const job = JOB.safeParse(workerData)
  return job.success
    ? { ok: true, page: convertHtmlJob({ ...job.data, charset: job.data.charset }) }
    : { ok: false, kind: 'failed', detail: 'the job did not parse' }
}

parentPort?.postMessage(convert())

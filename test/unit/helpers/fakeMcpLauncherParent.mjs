#!/usr/bin/env node
// Exits after the production M50 launcher has started its bounded orphan
// fixture. The job helper must observe this Node process HANDLE signalled and
// end itself and the orphan; neither process relies on an enumerated PID tree.

import path from 'node:path'
import { env, execPath, exit, stderr, stdout } from 'node:process'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers'

const bundle = env.M50_JOB_BUNDLE
const assembly = env.M50_JOB_ASSEMBLY
const fixture = env.M50_JOB_ORPHAN
if (!bundle || !assembly || !fixture || !env.SystemRoot) exit(2)
const { spawnMcpJob } = await import(pathToFileURL(bundle).href)
const helper = spawnMcpJob({
  assemblyPath: assembly,
  systemRoot: env.SystemRoot,
  file: execPath,
  args: [fixture],
  isVerbatim: false,
  cwd: path.dirname(fixture),
  env: { SystemRoot: env.SystemRoot, Path: env.Path, TEMP: env.TEMP },
  log: (message) => {
    stderr.write(`${message}\n`)
  },
})
const state = { output: '', isReported: false }
helper.stderr.on('data', (part) => {
  if (state.isReported) return
  state.output += part.toString('utf8')
  const orphanId = /ORPHAN_PID=(\d+)/.exec(state.output)?.[1]
  if (!orphanId) return
  state.isReported = true
  stdout.write(
    JSON.stringify({ helperPid: helper.pid, orphanPid: Number(orphanId) }) + '\n',
    () => {
      exit(0)
    },
  )
})
setTimeout(() => exit(3), 8000)

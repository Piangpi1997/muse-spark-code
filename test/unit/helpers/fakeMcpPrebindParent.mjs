#!/usr/bin/env node
// The creating Node exits immediately after starting the production helper.
// The control pipe dies with it, so no GO can authorize the marker fixture.

import path from 'node:path'
import { env, execPath, exit, stderr, stdout } from 'node:process'
import { pathToFileURL } from 'node:url'

const bundle = env.M50_JOB_BUNDLE
const executable = env.M50_JOB_EXECUTABLE
const fixture = env.M50_JOB_MARKER_FIXTURE
const marker = env.M50_JOB_MARKER
if (!bundle || !executable || !fixture || !marker || !env.SystemRoot) exit(2)
const { spawnMcpJob } = await import(pathToFileURL(bundle).href)
const helper = spawnMcpJob({
  executablePath: executable,
  file: execPath,
  args: [fixture],
  isVerbatim: false,
  cwd: path.dirname(fixture),
  env: { SystemRoot: env.SystemRoot, Path: env.Path, TEMP: env.TEMP, M50_START_MARKER: marker },
  log: (message) => {
    stderr.write(`${message}\n`)
  },
})
stdout.write(JSON.stringify({ helperPid: helper.pid }) + '\n', () => exit(0))

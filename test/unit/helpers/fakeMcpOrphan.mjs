#!/usr/bin/env node
// A bounded containment drill (M50). The MCP parent starts a child
// that outlives it, reports that child's PID, then exits. The child quits on
// its own after 12 seconds even if the extension fails to reap it.

import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { env, execPath, exit, platform, stderr, stdin } from 'node:process'

const ROLE = 'FAKE_MCP_ORPHAN_ROLE'

if (env[ROLE] === 'child') {
  const SELF_EXIT_MS = 12_000
  setTimeout(() => {
    exit(0)
  }, SELF_EXIT_MS)
} else {
  const PARENT_SELF_EXIT_MS = 5000
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the fixture starts only this Node with its own fixed file, and the child self-exits after 12 seconds; no model or workspace input reaches the command line (PLAN.md §8).
  const child = spawn(execPath, [fileURLToPath(import.meta.url)], {
    env: { ...env, [ROLE]: 'child' },
    stdio: 'ignore',
    windowsHide: true,
    // Windows tests the exited-parent orphan sweep; on POSIX the child
    // stays in the MCP parent's new process group for its exit cleanup.
    detached: platform === 'win32',
  })
  child.once('spawn', () => {
    stderr.write(`ORPHAN_PID=${String(child.pid)}\n`, () => {
      stdin.resume()
      stdin.once('data', () => {
        exit(0)
      })
      stdin.once('end', () => {
        exit(0)
      })
      setTimeout(() => {
        exit(0)
      }, PARENT_SELF_EXIT_MS)
    })
  })
  child.once('error', () => {
    exit(3)
  })
}

#!/usr/bin/env node
// The M50 binary stdio fixture: byte values that a text relay would change.
// It closes after EOF and self-exits if a failed launcher never delivers it.

import { Buffer } from 'node:buffer'
import { stdin, stdout, stderr, exit } from 'node:process'
import { setTimeout } from 'node:timers'

stderr.write(Buffer.from([0, 255]))
stdin.on('data', (bytes) => {
  stdout.write(bytes)
})
stdin.on('end', () => {
  exit(0)
})
setTimeout(() => {
  exit(2)
}, 5000)

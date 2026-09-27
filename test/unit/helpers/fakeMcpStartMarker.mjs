#!/usr/bin/env node
// A finite marker fixture: the withheld-GO test must never start this file.
import { writeFileSync } from 'node:fs'
import { env, exit, pid } from 'node:process'
import { setTimeout } from 'node:timers'

if (env.M50_START_MARKER) writeFileSync(env.M50_START_MARKER, String(pid))
setTimeout(() => exit(0), 5000)

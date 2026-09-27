// The Windows job helpers' C# ships beside the bundle instead of in it
// (PLAN.md D6; M55 moved the shared half, M56 the rest). What the host sends
// to or expects from that C# is a TypeScript constant, so these read the
// shipped files and hold the two together; the real compile and run are
// processTree.test.ts's and the MCP job tests' on Windows.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JOB_SOURCE_FILES } from '../../src/host/backend/jobSource'
import {
  MCP_JOB_CONFIG_VARIABLE,
  MCP_JOB_SELF_TEST_ARGUMENT,
  MCP_JOB_SELF_TEST_TOKEN,
  SHELL_JOB_TYPE_NAME,
} from '../../src/shared/constants'
import { readJobSource } from './helpers/jobSource'

const SHARED_TYPE = 'public static class MuseSparkMcpJob {'

describe("the Windows job helpers' shipped C# (PLAN.md D6)", () => {
  it('packages every file the helpers read', () => {
    // .vscodeignore excludes everything, then lets these through.
    const shipped = readFileSync(path.join(process.cwd(), '.vscodeignore'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('!'))
      .map((line) => line.slice(1).trim())
    for (const file of Object.values(JOB_SOURCE_FILES)) {
      expect(shipped).toContain(file.split(path.sep).join('/'))
    }
  })

  it('declares the shell job type the host joins and terminates by name', async () => {
    const csharp = await readJobSource('shellJob')
    expect(csharp).toContain(`public static class ${SHELL_JOB_TYPE_NAME} {`)
    expect(csharp).toContain('public static void Join(string name) {')
    expect(csharp).toContain('public static bool Terminate(string name, uint exitCode) {')
    expect(csharp).toContain(SHARED_TYPE)
  })

  it("answers the launcher's self-test and takes its configuration from the host's variable", async () => {
    const csharp = await readJobSource('mcpLauncher')
    expect(csharp).toContain(`arguments[0] == "${MCP_JOB_SELF_TEST_ARGUMENT}"`)
    expect(csharp).toContain(`Console.WriteLine("${MCP_JOB_SELF_TEST_TOKEN}");`)
    expect(csharp).toContain(`Environment.GetEnvironmentVariable("${MCP_JOB_CONFIG_VARIABLE}");`)
    expect(csharp).toContain(
      `Environment.SetEnvironmentVariable("${MCP_JOB_CONFIG_VARIABLE}", null);`,
    )
    expect(csharp).toContain(SHARED_TYPE)
  })

  it.each(['shellJob', 'mcpLauncher'] as const)(
    "puts every using directive of %s's source before its first type",
    async (helper) => {
      const csharp = await readJobSource(helper)
      const lastUsing = csharp.lastIndexOf('\nusing System')
      const firstType = csharp.search(/^(?:public |\[DataContract\])/m)
      expect(lastUsing).toBeGreaterThan(0)
      expect(firstType).toBeGreaterThan(lastUsing)
    },
  )
})

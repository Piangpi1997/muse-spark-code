// Compile the Windows MCP job launcher once per source version. Each server
// starts this executable directly; PowerShell is used only while preparing it.
// M27's shell-job DLL remains separate for shell commands.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { powerShellQuoted } from '../../core/shellQuote'
import { SHELL_JOB_FOLDER, WINDOWS_POWERSHELL_COMMAND_ARGS } from '../../shared/constants'
import { runProgram, windowsPowerShell } from '../processTree'
import { MCP_JOB_SOURCE } from './mcpJobSource'
import type { ShellJobDeps } from './shellJob'

const SELF_TEST_ARGUMENT = '--self-test'
const SELF_TEST_TOKEN = 'muse-spark-mcp-job-ready'

const SOURCE = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

${MCP_JOB_SOURCE}

[DataContract]
public sealed class MuseSparkMcpLaunchConfig {
  [DataMember(Name = "file", IsRequired = true)] public string File { get; set; }
  [DataMember(Name = "args", IsRequired = true)] public string[] Args { get; set; }
  [DataMember(Name = "cwd", IsRequired = true)] public string Cwd { get; set; }
  [DataMember(Name = "env", IsRequired = true)] public Dictionary<string, string> Env { get; set; }
  [DataMember(Name = "parentPid", IsRequired = true)] public uint ParentPid { get; set; }
  [DataMember(Name = "isVerbatim", IsRequired = true)] public bool IsVerbatim { get; set; }
  [DataMember(Name = "controlPipe", IsRequired = true)] public string ControlPipe { get; set; }
  [DataMember(Name = "controlNonce", IsRequired = true)] public string ControlNonce { get; set; }
}

public static class MuseSparkMcpJobEntry {
  public static int Main(string[] arguments) {
    try {
      if (arguments.Length == 1 && arguments[0] == "${SELF_TEST_ARGUMENT}") {
        Console.WriteLine("${SELF_TEST_TOKEN}");
        return 0;
      }
      if (arguments.Length != 0) throw new InvalidDataException("invalid MCP launcher arguments");
      string encoded = Environment.GetEnvironmentVariable("MUSE_SPARK_MCP_JOB_CONFIG");
      Environment.SetEnvironmentVariable("MUSE_SPARK_MCP_JOB_CONFIG", null);
      if (encoded == null) throw new InvalidDataException("missing MCP launch config");
      MuseSparkMcpLaunchConfig config;
      using (var stream = new MemoryStream(Convert.FromBase64String(encoded))) {
        var serializer = new DataContractJsonSerializer(typeof(MuseSparkMcpLaunchConfig),
          new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true });
        config = (MuseSparkMcpLaunchConfig)serializer.ReadObject(stream);
      }
      if (config == null || config.File == null || config.Args == null ||
          config.Cwd == null || config.Env == null || config.ControlPipe == null ||
          config.ControlNonce == null) throw new InvalidDataException("invalid MCP launch config");
      var pairs = new List<string>();
      foreach (var entry in config.Env) pairs.Add(entry.Key + "=" + entry.Value);
      return MuseSparkMcpJob.Run(config.File, config.Args, config.Cwd,
        config.ParentPid, pairs.ToArray(), config.IsVerbatim,
        config.ControlPipe, config.ControlNonce);
    } catch (Exception error) {
      Exception cause = error.GetBaseException();
      if (cause is Win32Exception) {
        Console.Error.WriteLine("MCP launcher Win32 error " + ((Win32Exception)cause).NativeErrorCode);
      } else {
        Console.Error.WriteLine("MCP launcher failed: " + cause.GetType().Name);
      }
      return 1;
    }
  }
}
`

const EXECUTABLE_STEM = 'MuseSparkMcpJob-'
const EXECUTABLE_EXTENSION = '.exe'
const SOURCE_EXTENSION = '.cs'
const DIGEST_LENGTH = 16

/** Same compile inputs as M27, with an independent source and executable. */
export type McpJobExecutableDeps = ShellJobDeps

async function isPresent(file: string): Promise<boolean> {
  try {
    const fileInfo = await stat(file)
    return fileInfo.isFile()
  } catch {
    return false
  }
}

export function mcpJobExecutableName(): string {
  const digest = createHash('sha256').update(SOURCE).digest('hex').slice(0, DIGEST_LENGTH)
  return `${EXECUTABLE_STEM}${digest}${EXECUTABLE_EXTENSION}`
}

async function compile(executable: string, deps: McpJobExecutableDeps): Promise<void> {
  const directory = path.dirname(executable)
  await mkdir(directory, { recursive: true })
  const stem = path.join(directory, randomUUID())
  const source = `${stem}${SOURCE_EXTENSION}`
  const output = `${stem}${EXECUTABLE_EXTENSION}`
  const powershell = windowsPowerShell(deps.systemRoot)
  try {
    await writeFile(source, SOURCE, 'utf8')
    await (deps.run ?? runProgram)(
      powershell.file,
      [
        ...WINDOWS_POWERSHELL_COMMAND_ARGS,
        `Add-Type -Path ${powerShellQuoted(source)} -OutputAssembly ${powerShellQuoted(output)} -OutputType ConsoleApplication -ReferencedAssemblies 'System.Runtime.Serialization','System.Xml'`,
      ],
      powershell.env,
    )
    try {
      await rename(output, executable)
    } catch (error: unknown) {
      if (!(await isPresent(executable))) throw error
    }
  } finally {
    await rm(source, { force: true })
    await rm(output, { force: true })
  }
}

async function removeStale(executable: string, log: (message: string) => void): Promise<void> {
  try {
    const directory = path.dirname(executable)
    const current = path.basename(executable)
    const names = await readdir(directory)
    for (const name of names) {
      if (
        name !== current &&
        name.startsWith(EXECUTABLE_STEM) &&
        name.endsWith(EXECUTABLE_EXTENSION)
      ) {
        await rm(path.join(directory, name), { force: true })
      }
    }
  } catch (error: unknown) {
    log(`an earlier MCP job executable could not be removed yet (${String(error)})`)
  }
}

async function verify(executable: string, deps: McpJobExecutableDeps): Promise<void> {
  let answer: string
  try {
    answer = await (deps.run ?? runProgram)(executable, [SELF_TEST_ARGUMENT], {
      SystemRoot: deps.systemRoot,
    })
  } catch (error: unknown) {
    throw new Error(`the MCP job executable self-test failed (${String(error)})`, { cause: error })
  }
  if (answer.trim() !== SELF_TEST_TOKEN) {
    throw new Error(`the MCP job executable self-test answered ${JSON.stringify(answer.trim())}`)
  }
}

/** Undefined means stdio MCP must fail closed on this Windows machine. */
export function mcpJobExecutable(deps: McpJobExecutableDeps): () => Promise<string | undefined> {
  let ready: Promise<string | undefined> | undefined
  return () =>
    (ready ??= (async () => {
      const executable = path.join(deps.storageDir, SHELL_JOB_FOLDER, mcpJobExecutableName())
      try {
        let didCompile = false
        if (!(await isPresent(executable))) {
          await compile(executable, deps)
          didCompile = true
        }
        await verify(executable, deps)
        if (didCompile) await removeStale(executable, deps.log)
        return executable
      } catch (error: unknown) {
        deps.log(`Windows MCP job executable is unavailable (${String(error)})`)
        return
      }
    })())
}

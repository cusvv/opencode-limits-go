import { execFile } from "node:child_process"
import os from "node:os"
import { promisify } from "node:util"

const exec = promisify(execFile)

export async function defaultRunCli(): Promise<unknown> {
  const win = process.platform === "win32"
  const command = win ? "cmd.exe" : "sh"
  const args = win ? ["/d", "/c", "opencode auth export"] : ["-c", "opencode auth export"]
  const { stdout } = await exec(command, args, {
    // 8s keeps credential discovery inside the status deadline.
    timeout: 8_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    // cmd.exe searches the current directory before PATH: never let a repo-provided opencode.cmd run.
    cwd: os.homedir(),
    env: win ? { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } : process.env,
  })
  // JSON.parse errors can quote a fragment of stdout containing tokens: do not rethrow the original error.
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error("opencode auth export did not return JSON")
  }
}

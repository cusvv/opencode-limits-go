import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { errorText, isNewerVersion } from "./model.ts"
import { log } from "./log.ts"

const exec = promisify(execFile)

export const REPO = "cusvv/zen-limits"
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const TOP_LEVEL_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "tsconfig.json",
  "tsconfig.gui.json",
  "vite.config.ts",
] as const

export type GitHubRelease = {
  tag_name?: unknown
  html_url?: unknown
  tarball_url?: unknown
  zipball_url?: unknown
  assets?: unknown
}

export type UpdateStatus = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  autoUpdated: boolean
  restartRequired: boolean
  releaseUrl: string
  checkedAtMs: number
  error: string
}

export type InstallResult = {
  ok: boolean
  version: string
  restartRequired: boolean
  error: string
}

export type UpdaterDeps = {
  pluginRoot?: string
  fetchFn?: typeof fetch
  extractFn?: (archivePath: string, outDir: string, kind: "tar.gz" | "zip") => Promise<void>
  nowFn?: () => number
  onInstalled?: (version: string) => void
}

export function defaultPluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
}

export function isTrustedGitHubUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "https:") return false
    const host = parsed.hostname.toLowerCase()
    return host === "github.com" || host === "api.github.com" || host.endsWith(".githubusercontent.com")
  } catch {
    return false
  }
}

export function normalizeTagVersion(tag: unknown): string {
  if (typeof tag !== "string") return ""
  return tag.trim().replace(/^v/i, "")
}

export function pickReleaseDownload(
  release: GitHubRelease,
): { url: string; kind: "tar.gz" | "zip" } | null {
  const assets = Array.isArray(release.assets)
    ? (release.assets as Array<{ name?: unknown; browser_download_url?: unknown }>)
    : []

  for (const asset of assets) {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : ""
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : ""
    if ((name.endsWith(".tar.gz") || name.endsWith(".tgz")) && isTrustedGitHubUrl(url)) {
      return { url, kind: "tar.gz" }
    }
  }

  for (const asset of assets) {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : ""
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : ""
    if (name.endsWith(".zip") && isTrustedGitHubUrl(url)) {
      return { url, kind: "zip" }
    }
  }

  if (typeof release.tarball_url === "string" && isTrustedGitHubUrl(release.tarball_url)) {
    return { url: release.tarball_url, kind: "tar.gz" }
  }

  if (typeof release.zipball_url === "string" && isTrustedGitHubUrl(release.zipball_url)) {
    return { url: release.zipball_url, kind: "zip" }
  }

  return null
}

async function defaultExtractArchive(
  archivePath: string,
  outDir: string,
  kind: "tar.gz" | "zip",
): Promise<void> {
  if (process.platform === "win32") {
    const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    await exec(tarExe, ["-xf", archivePath, "-C", outDir], { timeout: 30_000, windowsHide: true })
    return
  }
  if (kind === "zip") {
    await exec("unzip", ["-q", "-o", archivePath, "-d", outDir], { timeout: 30_000 })
    return
  }
  await exec("tar", ["-xzf", archivePath, "-C", outDir], { timeout: 30_000 })
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readPackageVersion(dir: string): Promise<{ name: string; version: string } | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
      name?: unknown
      version?: unknown
    }
    if (typeof raw.name !== "string" || typeof raw.version !== "string") return null
    return { name: raw.name, version: raw.version }
  } catch {
    return null
  }
}

export async function findVerifiedPluginRoot(extractDir: string): Promise<string> {
  const candidates = [extractDir, path.join(extractDir, "zen-limits")]
  for (const entry of await readdir(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(extractDir, entry.name))
  }

  for (const dir of candidates) {
    const pkg = await readPackageVersion(dir)
    if (!pkg || pkg.name !== "opencode-zen-limits") continue
    const hasIndex = await exists(path.join(dir, "src", "index.ts"))
    const hasTui = await exists(path.join(dir, "src", "tui.tsx"))
    const hasGui = await exists(path.join(dir, "dist", "gui-experimental.cjs"))
    if (hasIndex && hasTui && hasGui) return dir
  }

  throw new Error("Downloaded archive does not contain a valid zen-limits build")
}

export async function copyVerifiedPlugin(srcRoot: string, destRoot: string): Promise<void> {
  for (const rel of TOP_LEVEL_FILES) {
    const src = path.join(srcRoot, rel)
    if (await exists(src)) {
      await cp(src, path.join(destRoot, rel), { force: true })
    }
  }

  const destDist = path.join(destRoot, "dist")
  await mkdir(destDist, { recursive: true })
  await cp(path.join(srcRoot, "dist", "gui-experimental.cjs"), path.join(destDist, "gui-experimental.cjs"), {
    force: true,
  })

  const srcDir = path.join(srcRoot, "src")
  const destSrcDir = path.join(destRoot, "src")
  await mkdir(destSrcDir, { recursive: true })

  const nextFiles = new Set<string>()
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    nextFiles.add(entry.name)
    await cp(path.join(srcDir, entry.name), path.join(destSrcDir, entry.name), { force: true })
  }

  for (const entry of await readdir(destSrcDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !nextFiles.has(entry.name)) {
      await rm(path.join(destSrcDir, entry.name), { force: true })
    }
  }
}

export function createUpdater(deps: UpdaterDeps = {}) {
  const pluginRoot = deps.pluginRoot ?? defaultPluginRoot()
  const fetchFn = deps.fetchFn ?? fetch
  const extractFn = deps.extractFn ?? defaultExtractArchive
  const nowFn = deps.nowFn ?? Date.now

  let lastStatus: UpdateStatus | null = null
  let lastRelease: GitHubRelease | null = null
  let installedVersion: string | null = null
  let inflightCheck: Promise<UpdateStatus> | null = null
  let inflightInstall: Promise<InstallResult> | null = null

  async function currentVersion(): Promise<string> {
    const pkg = await readPackageVersion(pluginRoot)
    return pkg?.version ?? "0.0.0"
  }

  async function fetchLatestRelease(version: string): Promise<GitHubRelease | null> {
    const res = await fetchFn(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `opencode-zen-limits/${version}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
    return (await res.json()) as GitHubRelease
  }

  async function installFromRelease(release: GitHubRelease, expectedVersion: string): Promise<InstallResult> {
    if (inflightInstall) return inflightInstall

    const run = (async (): Promise<InstallResult> => {
      const download = pickReleaseDownload(release)
      if (!download) {
        return {
          ok: false,
          version: "",
          restartRequired: false,
          error: "Release contains no trusted download asset",
        }
      }

      const tmpBase = await mkdtemp(path.join(os.tmpdir(), "zen-limits-update-"))
      try {
        const archivePath = path.join(tmpBase, download.kind === "zip" ? "release.zip" : "release.tar.gz")
        const extractDir = path.join(tmpBase, "extracted")
        await mkdir(extractDir, { recursive: true })

        const res = await fetchFn(download.url, {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": `opencode-zen-limits/${await currentVersion()}`,
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
        if (res.url && !isTrustedGitHubUrl(res.url)) {
          throw new Error("Blocked redirect to untrusted download host")
        }

        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
          throw new Error(`Invalid archive size: ${bytes.byteLength} bytes`)
        }
        await writeFile(archivePath, bytes)

        await extractFn(archivePath, extractDir, download.kind)
        const verifiedRoot = await findVerifiedPluginRoot(extractDir)
        const pkg = await readPackageVersion(verifiedRoot)
        const targetVersion = pkg?.version ?? expectedVersion

        await copyVerifiedPlugin(verifiedRoot, pluginRoot)
        installedVersion = targetVersion
        deps.onInstalled?.(targetVersion)
        log("plugin auto-updated", { version: targetVersion })

        return { ok: true, version: targetVersion, restartRequired: true, error: "" }
      } catch (error) {
        const msg = errorText(error)
        log("plugin update failed", { error: msg })
        return { ok: false, version: "", restartRequired: false, error: msg }
      } finally {
        await rm(tmpBase, { recursive: true, force: true }).catch(() => {})
      }
    })()

    inflightInstall = run
    try {
      return await run
    } finally {
      inflightInstall = null
    }
  }

  async function check(opts: { force?: boolean; autoInstall?: boolean } = {}): Promise<UpdateStatus> {
    const runningVersion = await currentVersion()
    const effectiveCurrent = installedVersion ?? runningVersion
    const now = nowFn()

    if (!opts.force && lastStatus && now - lastStatus.checkedAtMs < CHECK_TTL_MS) {
      if (!opts.autoInstall || !lastStatus.updateAvailable || installedVersion) {
        return lastStatus
      }
    }

    if (inflightCheck) return inflightCheck

    const run = (async (): Promise<UpdateStatus> => {
      try {
        const release = await fetchLatestRelease(runningVersion)
        lastRelease = release
        const latestVersion = release ? normalizeTagVersion(release.tag_name) : ""
        const releaseUrl =
          release && typeof release.html_url === "string" && isTrustedGitHubUrl(release.html_url)
            ? release.html_url
            : `https://github.com/${REPO}/releases`

        const updateAvailable = !!latestVersion && isNewerVersion(latestVersion, effectiveCurrent)
        let autoUpdated = false
        let installError = ""

        if (release && updateAvailable && opts.autoInstall && !installedVersion) {
          const installed = await installFromRelease(release, latestVersion)
          autoUpdated = installed.ok
          if (!installed.ok) installError = installed.error
        }

        const status: UpdateStatus = {
          currentVersion: runningVersion,
          latestVersion: latestVersion || runningVersion,
          updateAvailable: updateAvailable && !autoUpdated && !installedVersion,
          autoUpdated,
          restartRequired: !!installedVersion,
          releaseUrl,
          checkedAtMs: nowFn(),
          error: installError,
        }
        lastStatus = status
        return status
      } catch (error) {
        const msg = errorText(error)
        log("update check failed", { error: msg })
        const status: UpdateStatus = {
          currentVersion: runningVersion,
          latestVersion: lastStatus?.latestVersion || runningVersion,
          updateAvailable: lastStatus?.updateAvailable ?? false,
          autoUpdated: false,
          restartRequired: !!installedVersion,
          releaseUrl: lastStatus?.releaseUrl || `https://github.com/${REPO}/releases`,
          checkedAtMs: nowFn(),
          error: msg,
        }
        lastStatus = status
        return status
      }
    })()

    inflightCheck = run
    try {
      return await run
    } finally {
      inflightCheck = null
    }
  }

  async function install(): Promise<InstallResult> {
    if (installedVersion) {
      return { ok: true, version: installedVersion, restartRequired: true, error: "" }
    }
    const status = await check({ force: true, autoInstall: false })
    if (status.error && !lastRelease) {
      return { ok: false, version: "", restartRequired: false, error: status.error }
    }
    if (!status.updateAvailable || !lastRelease) {
      return { ok: true, version: status.currentVersion, restartRequired: false, error: "" }
    }
    const result = await installFromRelease(lastRelease, status.latestVersion)
    if (result.ok) {
      lastStatus = {
        ...status,
        updateAvailable: false,
        autoUpdated: false,
        restartRequired: true,
        error: "",
      }
    }
    return result
  }

  return { check, install, currentVersion }
}

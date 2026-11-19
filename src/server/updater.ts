import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { errorText, isNewerVersion } from "../core/index.ts"
import { log } from "./log.ts"

const exec = promisify(execFile)

export const REPO = "cusvv/opencode-limits-go"
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024
const UPDATE_LOCK = ".update.lock"
const LOCK_STALE_MS = 15 * 60_000
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
  managedByPackageManager: boolean
  managedByDev: boolean
  releaseUrl: string
  checkedAtMs: number
  error: string
}

export function isDevInstall(pluginRoot: string): boolean {
  const resolved = path.resolve(pluginRoot)
  return existsSync(path.join(resolved, ".git")) || /[\\/]local-plugins[\\/]/i.test(resolved)
}

export function isPackageManagerInstall(pluginRoot: string): boolean {
  const resolved = path.resolve(pluginRoot)
  return /[\\/]\.cache[\\/]opencode[\\/]npm[\\/]|[\\/]node_modules[\\/]opencode-(?:zen-limits|limits-go)$/i.test(
    resolved,
  )
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
}

export function isTrustedGitHubUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "https:") return false
    const host = parsed.hostname.toLowerCase()
    return (
      host === "github.com" ||
      host === "api.github.com" ||
      host === "codeload.github.com" ||
      host.endsWith(".githubusercontent.com")
    )
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

export function pickChecksumAsset(release: GitHubRelease): string | null {
  const assets = Array.isArray(release.assets)
    ? (release.assets as Array<{ name?: unknown; browser_download_url?: unknown }>)
    : []
  for (const asset of assets) {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : ""
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : ""
    if ((name === "sha256sums" || name === "sha256sums.txt" || name.endsWith(".sha256")) && isTrustedGitHubUrl(url)) {
      return url
    }
  }
  return null
}

export function parseChecksum(text: string, archiveName: string): string | null {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (!match) continue
    const file = match[2].trim().split(/[\\/]/).pop() ?? ""
    if (file === archiveName || (!file && lines.length === 1)) return match[1].toLowerCase()
  }
  return null
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function acquireUpdateLock(root: string): Promise<() => Promise<void>> {
  const lockPath = path.join(root, UPDATE_LOCK)
  const attempt = async (): Promise<void> => {
    const handle = await open(lockPath, "wx", 0o600)
    try {
      await handle.write(`${process.pid} ${Date.now()}`)
    } finally {
      await handle.close()
    }
  }
  try {
    await attempt()
  } catch {
    const info = await stat(lockPath).catch(() => null)
    if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) {
      throw new Error("Another update is already running")
    }
    await rm(lockPath, { force: true }).catch(() => {})
    try {
      await attempt()
    } catch {
      throw new Error("Another update is already running")
    }
  }
  return async () => {
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

async function assertExtractedSize(dir: string, total = { bytes: 0 }): Promise<number> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Extracted archive contains a symbolic link")
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await assertExtractedSize(full, total)
    } else if (entry.isFile()) {
      total.bytes += (await stat(full)).size
      if (total.bytes > MAX_EXTRACTED_BYTES) throw new Error("Extracted archive is too large")
    }
  }
  return total.bytes
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
  const candidates = [extractDir, path.join(extractDir, "opencode-limits-go"), path.join(extractDir, "zen-limits")]
  for (const entry of await readdir(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(extractDir, entry.name))
  }

  for (const dir of candidates) {
    const pkg = await readPackageVersion(dir)
    if (!pkg || pkg.name !== "opencode-limits-go") continue
    const hasIndex = await exists(path.join(dir, "src", "index.ts"))
    const hasTui = await exists(path.join(dir, "src", "tui.tsx"))
    const hasGui = await exists(path.join(dir, "dist", "gui-experimental.cjs"))
    if (hasIndex && hasTui && hasGui) return dir
  }

  throw new Error("Downloaded archive does not contain a valid opencode-limits-go build")
}

async function syncSourceTree(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const nextEntries = new Set<string>()

  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    nextEntries.add(entry.name)
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await syncSourceTree(srcPath, destPath)
    } else if (entry.isFile()) {
      await cp(srcPath, destPath, { force: true })
    }
  }

  for (const entry of await readdir(destDir, { withFileTypes: true })) {
    if (nextEntries.has(entry.name)) continue
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await rm(destPath, { recursive: true, force: true })
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      await rm(destPath, { force: true })
    }
  }
}

export async function copyVerifiedPlugin(srcRoot: string, destRoot: string): Promise<void> {
  // package.json goes last: if the copy is interrupted, the next start must see the old version and retry.
  for (const rel of TOP_LEVEL_FILES) {
    if (rel === "package.json") continue
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

  await syncSourceTree(path.join(srcRoot, "src"), path.join(destRoot, "src"))
  await cp(path.join(srcRoot, "package.json"), path.join(destRoot, "package.json"), { force: true })
}

export function createUpdater(deps: UpdaterDeps = {}) {
  const pluginRoot = deps.pluginRoot ?? defaultPluginRoot()
  const managedByPackageManager = isPackageManagerInstall(pluginRoot)
  const managedByDev = isDevInstall(pluginRoot)
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
        "User-Agent": `opencode-limits-go/${version}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return null
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || "0")
      const wait = reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 0
      const hint = wait > 0 ? `; retry in ${Math.ceil(wait / 60_000)}m` : ""
      throw new Error(`GitHub API rate limited (HTTP ${res.status})${hint}`)
    }
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

      const tmpBase = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-update-"))
      let releaseLock: (() => Promise<void>) | null = null
      try {
        releaseLock = await acquireUpdateLock(pluginRoot)
        const archiveName = new URL(download.url).pathname.split("/").pop() || "release"
        const archivePath = path.join(tmpBase, download.kind === "zip" ? "release.zip" : "release.tar.gz")
        const extractDir = path.join(tmpBase, "extracted")
        await mkdir(extractDir, { recursive: true })

        const checksumUrl = pickChecksumAsset(release)
        if (!checksumUrl) throw new Error("Release has no SHA256SUMS; refusing to install unverified code")
        const checksumRes = await fetchFn(checksumUrl, {
          headers: { Accept: "text/plain", "User-Agent": `opencode-limits-go/${await currentVersion()}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!checksumRes.ok) throw new Error(`Checksum download failed: HTTP ${checksumRes.status}`)
        const expectedHash = parseChecksum(await checksumRes.text(), archiveName)
        if (!expectedHash) throw new Error(`SHA256SUMS has no entry for ${archiveName}`)

        const res = await fetchFn(download.url, {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": `opencode-limits-go/${await currentVersion()}`,
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
        if (res.url && !isTrustedGitHubUrl(res.url)) {
          throw new Error("Blocked redirect to untrusted download host")
        }

        const contentLength = Number(res.headers.get("content-length") || "0")
        if (contentLength > MAX_ARCHIVE_BYTES) throw new Error(`Archive is too large: ${contentLength} bytes`)
        const chunks: Uint8Array[] = []
        let total = 0
        const reader = res.body?.getReader()
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            total += value.byteLength
            if (total > MAX_ARCHIVE_BYTES) throw new Error(`Archive is too large: more than ${MAX_ARCHIVE_BYTES} bytes`)
            chunks.push(value)
          }
        } else {
          const value = new Uint8Array(await res.arrayBuffer())
          total = value.byteLength
          chunks.push(value)
        }
        if (total === 0 || total > MAX_ARCHIVE_BYTES) throw new Error(`Invalid archive size: ${total} bytes`)
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        if (sha256(bytes) !== expectedHash) throw new Error("Downloaded archive checksum does not match SHA256SUMS")
        await writeFile(archivePath, bytes)

        await extractFn(archivePath, extractDir, download.kind)
        await assertExtractedSize(extractDir)
        const verifiedRoot = await findVerifiedPluginRoot(extractDir)
        const pkg = await readPackageVersion(verifiedRoot)
        if (!pkg || pkg.version !== expectedVersion) {
          throw new Error(`Release version mismatch: archive has ${pkg?.version ?? "unknown"}, expected ${expectedVersion}`)
        }
        const targetVersion = pkg.version

        await copyVerifiedPlugin(verifiedRoot, pluginRoot)
        const installed = await readPackageVersion(pluginRoot)
        if (!installed || installed.version !== targetVersion) throw new Error("Installed files did not verify after copy")
        installedVersion = targetVersion
        deps.onInstalled?.(targetVersion)
        log("plugin auto-updated", { version: targetVersion })

        return { ok: true, version: targetVersion, restartRequired: true, error: "" }
      } catch (error) {
        const msg = errorText(error)
        log("plugin update failed", { error: msg })
        return { ok: false, version: "", restartRequired: false, error: msg }
      } finally {
        await releaseLock?.()
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

    // Never cache a failed check for six hours: a temporary 403/429 must retry.
    if (!opts.force && lastStatus && !lastStatus.error && now - lastStatus.checkedAtMs < CHECK_TTL_MS) {
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

        if (release && updateAvailable && opts.autoInstall && !installedVersion && !managedByPackageManager && !managedByDev) {
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
          managedByPackageManager,
          managedByDev,
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
          managedByPackageManager,
          managedByDev,
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
    if (managedByPackageManager) {
      return {
        ok: false,
        version: "",
        restartRequired: false,
        error: "Managed by OpenCode package manager. Run: opencode plugin update",
      }
    }
    if (managedByDev) {
      return {
        ok: false,
        version: "",
        restartRequired: false,
        error: "Development install (git or local-plugins). Update with git pull; automatic overwrite is disabled.",
      }
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

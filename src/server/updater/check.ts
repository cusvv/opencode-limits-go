import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { errorText, isNewerVersion } from "../../core/index.ts"
import { log } from "../log.ts"
import { anySignal } from "../platform.ts"
import {
  MAX_ARCHIVE_BYTES,
  assertExtractedSize,
  defaultExtractArchive,
  findVerifiedPluginRoot,
  inspectArchive,
} from "./archive.ts"
import {
  acquireUpdateLock,
  backupPlugin,
  copyVerifiedPlugin,
  missingRuntimeDeps,
  readPackageVersion,
  restorePlugin,
  sha256,
} from "./install.ts"
import {
  REPO,
  isTrustedGitHubUrl,
  normalizeTagVersion,
  parseChecksum,
  pickChecksumAsset,
  pickReleaseDownload,
  type GitHubRelease,
} from "./release.ts"

const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const CHECK_TTL_MS = 6 * 60 * 60 * 1000

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
  inspectFn?: (archivePath: string, kind: "tar.gz" | "zip") => Promise<void>
  nowFn?: () => number
  onInstalled?: (version: string) => void
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

export function defaultPluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
}

export function createUpdater(deps: UpdaterDeps = {}) {
  const pluginRoot = deps.pluginRoot ?? defaultPluginRoot()
  const managedByPackageManager = isPackageManagerInstall(pluginRoot)
  const managedByDev = isDevInstall(pluginRoot)
  const fetchFn = deps.fetchFn ?? fetch
  const extractFn = deps.extractFn ?? defaultExtractArchive
  const inspectFn = deps.inspectFn ?? inspectArchive
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

  async function fetchLatestRelease(version: string, signal?: AbortSignal): Promise<GitHubRelease | null> {
    const res = await fetchFn(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `opencode-limits-go/${version}`,
      },
      signal: signal ? anySignal([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
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

  async function installFromRelease(
    release: GitHubRelease,
    expectedVersion: string,
    signal?: AbortSignal,
  ): Promise<InstallResult> {
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
          signal: signal ? anySignal([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
        })
        if (!checksumRes.ok) throw new Error(`Checksum download failed: HTTP ${checksumRes.status}`)
        const expectedHash = parseChecksum(await checksumRes.text(), archiveName)
        if (!expectedHash) throw new Error(`SHA256SUMS has no entry for ${archiveName}`)

        const res = await fetchFn(download.url, {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": `opencode-limits-go/${await currentVersion()}`,
          },
          signal: signal ? anySignal([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000),
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

        await inspectFn(archivePath, download.kind)
        await extractFn(archivePath, extractDir, download.kind)
        await assertExtractedSize(extractDir)
        const verifiedRoot = await findVerifiedPluginRoot(extractDir)
        const pkg = await readPackageVersion(verifiedRoot)
        if (!pkg || pkg.version !== expectedVersion) {
          throw new Error(`Release version mismatch: archive has ${pkg?.version ?? "unknown"}, expected ${expectedVersion}`)
        }
        const targetVersion = pkg.version

        const backupDir = path.join(tmpBase, "backup")
        await backupPlugin(pluginRoot, backupDir)
        try {
          await copyVerifiedPlugin(verifiedRoot, pluginRoot)
          const installed = await readPackageVersion(pluginRoot)
          if (!installed || installed.version !== targetVersion) {
            throw new Error("Installed files did not verify after copy")
          }
        } catch (error) {
          await restorePlugin(backupDir, pluginRoot).catch((restoreError) => {
            log("plugin rollback failed", { error: errorText(restoreError) })
          })
          throw error
        }
        installedVersion = targetVersion
        deps.onInstalled?.(targetVersion)
        log("plugin auto-updated", { version: targetVersion })
        const missingDeps = await missingRuntimeDeps(pluginRoot)
        if (missingDeps.length) log("update installed; missing runtime dependencies", { missing: missingDeps })
        return {
          ok: true,
          version: targetVersion,
          restartRequired: true,
          error: missingDeps.length ? `Run npm install: ${missingDeps.join(", ")}` : "",
        }
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

  async function check(
    opts: { force?: boolean; autoInstall?: boolean; signal?: AbortSignal } = {},
  ): Promise<UpdateStatus> {
    const runningVersion = await currentVersion()
    const effectiveCurrent = installedVersion ?? runningVersion
    const now = nowFn()

    // Never cache a failed check for six hours: a temporary 403/429 must retry.
    if (!opts.force && lastStatus && !lastStatus.error && now - lastStatus.checkedAtMs < CHECK_TTL_MS) {
      if (
        !opts.autoInstall ||
        !lastStatus.updateAvailable ||
        installedVersion ||
        managedByDev ||
        managedByPackageManager
      ) {
        return lastStatus
      }
    }

    if (inflightCheck) return inflightCheck

    const run = (async (): Promise<UpdateStatus> => {
      try {
        const release = await fetchLatestRelease(runningVersion, opts.signal)
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
          const installed = await installFromRelease(release, latestVersion, opts.signal)
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

  async function install(opts: { signal?: AbortSignal } = {}): Promise<InstallResult> {
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
    const status = await check({ force: true, autoInstall: false, signal: opts.signal })
    if (status.error && !lastRelease) {
      return { ok: false, version: "", restartRequired: false, error: status.error }
    }
    if (!status.updateAvailable || !lastRelease) {
      return { ok: true, version: status.currentVersion, restartRequired: false, error: "" }
    }
    const result = await installFromRelease(lastRelease, status.latestVersion, opts.signal)
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

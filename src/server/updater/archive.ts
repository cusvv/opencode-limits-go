import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { errorText } from "../../core/index.ts"
import { hasUnzip, tarCommand } from "../platform.ts"
import { readPackageVersion } from "./install.ts"

const exec = promisify(execFile)

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
export const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024

export type ArchiveListing = { bytes: number; entries: number }

// GNU tar: "-rw-r--r-- user/group 123 2024-01-01 12:00 dir/file"
// bsdtar:  "-rw-r--r--  0 0  0  123 Jan  1 12:00 dir/file" (or "Jan  1  2023" for old entries)
const TAR_LINE = new RegExp(
  String.raw`^(\S+)\s+.*?\s(\d+)\s+(?:\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?|\S+\s+\d{1,2}\s+(?:\d{1,2}:\d{2}(?::\d{2})?|\d{4}))\s+(.+)$`,
)
// unzip uses the host locale for dates: accept YYYY-MM-DD and MM-DD-YYYY/DD-MM-YYYY (with - . /).
const ZIP_LINE = /^\s*(\d+)\s+(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})\s+\d{2}:\d{2}\s+(.+)$/

function assertSafeArchivePath(name: string): void {
  const normalized = name.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Archive entry escapes the install root: ${name}`)
  }
}

/**
 * Parse `tar -tvzf` output (GNU tar or bsdtar). Rejects links, unsafe paths, and oversized archives.
 * Throws on any unparseable line: the caller must fail closed.
 */
export function parseTarListing(listing: string, maxBytes: number = MAX_EXTRACTED_BYTES): ArchiveListing {
  let bytes = 0
  let entries = 0
  for (const raw of listing.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const match = raw.match(TAR_LINE)
    if (!match) throw new Error(`Unparseable tar listing line: ${raw.trim()}`)
    const [, mode, sizeText, name] = match
    const type = mode.charAt(0)
    if (type === "l") throw new Error("Archive contains a symbolic link")
    if (type === "h") throw new Error("Archive contains a hard link")
    assertSafeArchivePath(name)
    entries++
    if (type === "-") {
      bytes += Number(sizeText)
      if (bytes > maxBytes) throw new Error("Extracted archive is too large")
    }
  }
  if (!entries) throw new Error("Archive listing is empty")
  return { bytes, entries }
}

/**
 * Parse `unzip -l` output (`sizes: true`) or `tar -tf` names-only output (`sizes: false`).
 * Rejects unsafe paths and oversized archives; throws when the listing cannot be parsed.
 */
export function parseZipListing(
  listing: string,
  options: { sizes?: boolean; maxBytes?: number } = {},
): ArchiveListing {
  const sizes = options.sizes ?? true
  const maxBytes = options.maxBytes ?? MAX_EXTRACTED_BYTES
  let bytes = 0
  let entries = 0
  for (const raw of listing.split(/\r?\n/)) {
    if (!raw.trim()) continue
    let name: string
    if (sizes) {
      const match = raw.match(ZIP_LINE)
      // Archive:/Length header/footer lines are not entries.
      if (!match) {
        if (/^Archive:|^\s*Length\s|^\s*-+\s|^\s*\d+\s+\d+\s+files?$/.test(raw)) continue
        throw new Error(`Unparseable zip listing line: ${raw.trim()}`)
      }
      name = match[2].trim()
      bytes += Number(match[1])
      if (bytes > maxBytes) throw new Error("Extracted archive is too large")
    } else {
      name = raw.trim()
    }
    if (name.includes(" -> ")) throw new Error("Archive contains a symbolic link")
    assertSafeArchivePath(name)
    entries++
  }
  if (!entries) throw new Error("Archive listing is empty")
  return { bytes, entries }
}

export async function assertExtractedSize(dir: string, total = { bytes: 0 }): Promise<number> {
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

export async function readArchiveListing(archivePath: string, kind: "tar.gz" | "zip"): Promise<string> {
  const win = process.platform === "win32"
  const options = { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  if (kind === "tar.gz") {
    const { stdout } = await exec(tarCommand(), ["-tvzf", archivePath], options)
    return stdout
  }
  // Windows bsdtar has no `unzip`: `tar -tf` lists zip names without sizes (checked separately).
  if (win) {
    const { stdout } = await exec(tarCommand(), ["-tf", archivePath], options)
    return stdout
  }
  if (!hasUnzip()) throw new Error("unzip is required to verify the zip archive")
  const { stdout } = await exec("unzip", ["-l", archivePath], options)
  return stdout
}

/**
 * Inspect the archive listing before extraction. Security checks must pass on the listing:
 * an unreadable or unparseable listing means the install is refused.
 */
export async function inspectArchive(archivePath: string, kind: "tar.gz" | "zip"): Promise<void> {
  let listing: string
  try {
    listing = await readArchiveListing(archivePath, kind)
  } catch (error) {
    throw new Error(`Archive listing failed: ${errorText(error)}`)
  }
  if (kind === "tar.gz") parseTarListing(listing)
  else parseZipListing(listing, { sizes: process.platform !== "win32" })
}

export async function defaultExtractArchive(
  archivePath: string,
  outDir: string,
  kind: "tar.gz" | "zip",
): Promise<void> {
  if (process.platform === "win32") {
    await exec(tarCommand(), ["-xf", archivePath, "-C", outDir], { timeout: 30_000, windowsHide: true })
    return
  }
  if (kind === "zip") {
    await exec("unzip", ["-q", "-o", archivePath, "-d", outDir], { timeout: 30_000 })
    return
  }
  await exec(tarCommand(), ["-xzf", archivePath, "-C", outDir], { timeout: 30_000 })
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
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

import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"

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

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function readLockOwner(lockPath: string): Promise<string | null> {
  try {
    return (await readFile(lockPath, "utf8")).trim()
  } catch {
    return null
  }
}

/** Remove the lock only when it still belongs to `token`; returns whether it was removed. */
export async function releaseIfOwned(lockPath: string, token: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath)
  if (!owner || owner !== token) return false
  try {
    await rm(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

export async function acquireUpdateLock(root: string): Promise<() => Promise<void>> {
  const lockPath = path.join(root, UPDATE_LOCK)
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString("hex")}`
  const attempt = async (): Promise<void> => {
    const handle = await open(lockPath, "wx", 0o600)
    try {
      await handle.write(token)
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
    await releaseIfOwned(lockPath, token)
  }
}

export async function missingRuntimeDeps(dir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>
    }
    const deps = Object.keys(raw.dependencies ?? {})
    return deps.filter((dep) => !existsSync(path.join(dir, "node_modules", ...dep.split("/"), "package.json")))
  } catch {
    return []
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export async function readPackageVersion(dir: string): Promise<{ name: string; version: string } | null> {
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

export async function syncSourceTree(srcDir: string, destDir: string): Promise<void> {
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

export async function backupPlugin(destRoot: string, backupRoot: string): Promise<void> {
  await mkdir(backupRoot, { recursive: true })
  for (const rel of TOP_LEVEL_FILES) {
    const src = path.join(destRoot, rel)
    if (await exists(src)) await cp(src, path.join(backupRoot, rel), { force: true })
  }
  if (await exists(path.join(destRoot, "src"))) {
    await cp(path.join(destRoot, "src"), path.join(backupRoot, "src"), { recursive: true, force: true })
  }
  const gui = path.join(destRoot, "dist", "gui-experimental.cjs")
  if (await exists(gui)) {
    await mkdir(path.join(backupRoot, "dist"), { recursive: true })
    await cp(gui, path.join(backupRoot, "dist", "gui-experimental.cjs"), { force: true })
  }
}

export async function restorePlugin(backupRoot: string, destRoot: string): Promise<void> {
  for (const rel of TOP_LEVEL_FILES) {
    const src = path.join(backupRoot, rel)
    const dest = path.join(destRoot, rel)
    if (await exists(src)) await cp(src, dest, { force: true })
    else await rm(dest, { force: true })
  }
  const srcBackup = path.join(backupRoot, "src")
  const destSrc = path.join(destRoot, "src")
  if (await exists(srcBackup)) {
    // Replace the whole tree: a failed copy may have added files the backup never had.
    await rm(destSrc, { recursive: true, force: true })
    await cp(srcBackup, destSrc, { recursive: true, force: true })
  } else {
    await rm(destSrc, { recursive: true, force: true })
  }
  const gui = path.join(backupRoot, "dist", "gui-experimental.cjs")
  const destGui = path.join(destRoot, "dist", "gui-experimental.cjs")
  if (await exists(gui)) {
    await mkdir(path.dirname(destGui), { recursive: true })
    await cp(gui, destGui, { force: true })
  } else {
    await rm(destGui, { force: true })
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

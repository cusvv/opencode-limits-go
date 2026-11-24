import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  copyVerifiedPlugin,
  createUpdater,
  findVerifiedPluginRoot,
  isPackageManagerInstall,
  isTrustedGitHubUrl,
  parseChecksum,
  parseTarListing,
  parseZipListing,
  pickChecksumAsset,
  pickReleaseDownload,
  readLockOwner,
  releaseIfOwned,
  restorePlugin,
} from "./updater.ts"

const ARCHIVE_BYTES = new Uint8Array([1, 2, 3, 4])
const ARCHIVE_HASH = createHash("sha256").update(ARCHIVE_BYTES).digest("hex")

test("isTrustedGitHubUrl accepts only HTTPS GitHub hosts", () => {
  assert.equal(isTrustedGitHubUrl("https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.0/a.tar.gz"), true)
  assert.equal(isTrustedGitHubUrl("https://api.github.com/repos/cusvv/opencode-limits-go/releases/latest"), true)
  assert.equal(isTrustedGitHubUrl("https://objects.githubusercontent.com/github-production-release-asset/123"), true)
  assert.equal(isTrustedGitHubUrl("http://github.com/cusvv/opencode-limits-go"), false)
  assert.equal(isTrustedGitHubUrl("https://evil.example.com/opencode-limits-go.tar.gz"), false)
})

test("pickReleaseDownload prefers tar.gz asset, then zip asset, then tarball_url", () => {
  assert.deepEqual(
    pickReleaseDownload({
      assets: [
        { name: "opencode-limits-go.zip", browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.0/opencode-limits-go.zip" },
        { name: "opencode-limits-go.tar.gz", browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.0/opencode-limits-go.tar.gz" },
      ],
      tarball_url: "https://api.github.com/repos/cusvv/opencode-limits-go/tarball/v1.5.0",
    }),
    { url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.0/opencode-limits-go.tar.gz", kind: "tar.gz" },
  )

  assert.deepEqual(
    pickReleaseDownload({
      assets: [{ name: "bad.tar.gz", browser_download_url: "https://evil.test/bad.tar.gz" }],
      tarball_url: "https://api.github.com/repos/cusvv/opencode-limits-go/tarball/v1.5.0",
    }),
    { url: "https://api.github.com/repos/cusvv/opencode-limits-go/tarball/v1.5.0", kind: "tar.gz" },
  )
})

test("checksum assets are required and parsed by archive name", () => {
  const release = {
    assets: [
      { name: "SHA256SUMS", browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/SHA256SUMS" },
      { name: "opencode-limits-go.tar.gz", browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/opencode-limits-go.tar.gz" },
    ],
  }
  assert.equal(
    pickChecksumAsset(release),
    "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/SHA256SUMS",
  )
  const hash = "a".repeat(64)
  assert.equal(parseChecksum(`${hash}  opencode-limits-go.tar.gz\n`, "opencode-limits-go.tar.gz"), hash)
  assert.equal(parseChecksum(`${hash}  other.tar.gz\n`, "opencode-limits-go.tar.gz"), null)
})

test("findVerifiedPluginRoot and copyVerifiedPlugin stage and replace plugin files cleanly", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-updater-test-"))
  try {
    const extracted = path.join(tmp, "extracted")
    const pkgRoot = path.join(extracted, "cusvv-opencode-limits-go-abc123")
    await mkdir(path.join(pkgRoot, "src"), { recursive: true })
    await mkdir(path.join(pkgRoot, "dist"), { recursive: true })
    await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.6.0" }))
    await writeFile(path.join(pkgRoot, "src", "index.ts"), "// new index")
    await writeFile(path.join(pkgRoot, "src", "tui.tsx"), "// new tui")
    await writeFile(path.join(pkgRoot, "dist", "gui-experimental.cjs"), "// new gui")

    const found = await findVerifiedPluginRoot(extracted)
    assert.equal(found, pkgRoot)

    const dest = path.join(tmp, "installed")
    await mkdir(path.join(dest, "src"), { recursive: true })
    await mkdir(path.join(dest, "node_modules", "keep"), { recursive: true })
    await writeFile(path.join(dest, "src", "obsolete.ts"), "// should be removed")
    await writeFile(path.join(dest, "node_modules", "keep", "index.js"), "// keep me")

    await copyVerifiedPlugin(found, dest)
    assert.equal(await readFile(path.join(dest, "src", "index.ts"), "utf8"), "// new index")
    assert.equal(await readFile(path.join(dest, "dist", "gui-experimental.cjs"), "utf8"), "// new gui")
    assert.equal(await readFile(path.join(dest, "node_modules", "keep", "index.js"), "utf8"), "// keep me")
    await assert.rejects(readFile(path.join(dest, "src", "obsolete.ts"), "utf8"))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("createUpdater detects newer release and auto-installs once", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-auto-test-"))
  try {
    await mkdir(path.join(tmp, "src"), { recursive: true })
    await mkdir(path.join(tmp, "dist"), { recursive: true })
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.5.0" }))

    let notified = ""
    const updater = createUpdater({
      pluginRoot: tmp,
      fetchFn: async (input) => {
        const url = String(input)
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.5.1",
              html_url: "https://github.com/cusvv/opencode-limits-go/releases/tag/v1.5.1",
              assets: [
                {
                  name: "opencode-limits-go.tar.gz",
                  browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/opencode-limits-go.tar.gz",
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/SHA256SUMS",
                },
              ],
            }),
            { status: 200 },
          )
        }
        if (url.endsWith("/SHA256SUMS")) {
          return new Response(`${ARCHIVE_HASH}  opencode-limits-go.tar.gz\n`, { status: 200 })
        }
        return new Response(ARCHIVE_BYTES, { status: 200 })
      },
      inspectFn: async () => {},
      extractFn: async (_archive, outDir) => {
        const root = path.join(outDir, "opencode-limits-go")
        await mkdir(path.join(root, "src"), { recursive: true })
        await mkdir(path.join(root, "dist"), { recursive: true })
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.5.1" }))
        await writeFile(path.join(root, "src", "index.ts"), "// 1.5.1")
        await writeFile(path.join(root, "src", "tui.tsx"), "// 1.5.1")
        await writeFile(path.join(root, "dist", "gui-experimental.cjs"), "// 1.5.1")
      },
      onInstalled: (v) => {
        notified = v
      },
    })

    const res = await updater.check({ force: true, autoInstall: true })
    assert.equal(res.currentVersion, "1.5.0")
    assert.equal(res.latestVersion, "1.5.1")
    assert.equal(res.autoUpdated, true)
    assert.equal(res.restartRequired, true)
    assert.equal(res.updateAvailable, false)
    assert.equal(notified, "1.5.1")
    assert.equal(JSON.parse(await readFile(path.join(tmp, "package.json"), "utf8")).version, "1.5.1")
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("createUpdater never overwrites a git/local-plugins development install", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-dev-"))
  try {
    await mkdir(path.join(tmp, ".git"), { recursive: true })
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.5.0" }))
    const updater = createUpdater({
      pluginRoot: tmp,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            tag_name: "v1.5.1",
            html_url: "https://github.com/cusvv/opencode-limits-go/releases/tag/v1.5.1",
          }),
          { status: 200 },
        ),
    })
    const res = await updater.check({ force: true, autoInstall: true })
    assert.equal(res.managedByDev, true)
    assert.equal(res.autoUpdated, false)
    assert.equal(res.updateAvailable, true)
    const manual = await updater.install()
    assert.equal(manual.ok, false)
    assert.ok(manual.error.includes("git pull"))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("isPackageManagerInstall skips GitHub file overwrite when inside OpenCode npm cache", async () => {
  const pkgPath = path.join(os.tmpdir(), ".cache", "opencode", "npm", "opencode-limits-go@latest", "node_modules", "opencode-limits-go")
  assert.equal(isPackageManagerInstall(pkgPath), true)
  assert.equal(isPackageManagerInstall(path.join(os.tmpdir(), "local-plugins", "opencode-limits-go")), false)

  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-pm-"))
  const managedRoot = path.join(tmp, ".cache", "opencode", "npm", "opencode-limits-go@latest", "1", "node_modules", "opencode-limits-go")
  try {
    await mkdir(managedRoot, { recursive: true })
    await writeFile(path.join(managedRoot, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.5.0" }))

    const updater = createUpdater({
      pluginRoot: managedRoot,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            tag_name: "v1.6.0",
            html_url: "https://github.com/cusvv/opencode-limits-go/releases/tag/v1.6.0",
          }),
          { status: 200 },
        ),
    })

    const res = await updater.check({ force: true, autoInstall: true })
    assert.equal(res.managedByPackageManager, true)
    assert.equal(res.updateAvailable, true)
    assert.equal(res.autoUpdated, false)
    assert.equal(res.restartRequired, false)

    const manual = await updater.install()
    assert.equal(manual.ok, false)
    assert.ok(manual.error.includes("opencode plugin update"))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("copyVerifiedPlugin recursively syncs src subdirectories and removes obsolete nested files/dirs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-nested-test-"))
  try {
    const srcRoot = path.join(tmp, "src-release")
    await mkdir(path.join(srcRoot, "src", "gui"), { recursive: true })
    await mkdir(path.join(srcRoot, "dist"), { recursive: true })
    await writeFile(path.join(srcRoot, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.6.0" }))
    await writeFile(path.join(srcRoot, "src", "index.ts"), "// index")
    await writeFile(path.join(srcRoot, "src", "tui.tsx"), "// tui")
    await writeFile(path.join(srcRoot, "src", "gui", "i18n.ts"), "// i18n")
    await writeFile(path.join(srcRoot, "dist", "gui-experimental.cjs"), "// gui bundle")

    const destRoot = path.join(tmp, "dest")
    await mkdir(path.join(destRoot, "src", "gui"), { recursive: true })
    await mkdir(path.join(destRoot, "src", "legacy"), { recursive: true })
    await writeFile(path.join(destRoot, "src", "gui", "old.ts"), "// old")
    await writeFile(path.join(destRoot, "src", "legacy", "dead.ts"), "// dead")

    await copyVerifiedPlugin(srcRoot, destRoot)
    assert.equal(await readFile(path.join(destRoot, "src", "gui", "i18n.ts"), "utf8"), "// i18n")
    await assert.rejects(readFile(path.join(destRoot, "src", "gui", "old.ts"), "utf8"))
    await assert.rejects(readFile(path.join(destRoot, "src", "legacy", "dead.ts"), "utf8"))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("parseTarListing accepts GNU and bsdtar listings and sums file sizes", () => {
  const gnu = [
    "-rw-r--r-- root/root      1234 2024-05-01 12:34 opencode-limits-go/package.json",
    "-rw-r--r-- root/root       567 2024-05-01 12:34 opencode-limits-go/src/index.ts",
    "drwxr-xr-x root/root         0 2024-05-01 12:34 opencode-limits-go/src/",
  ].join("\n")
  assert.deepEqual(parseTarListing(gnu), { bytes: 1801, entries: 3 })

  const bsdtar = [
    "-rw-r--r--  0 0      0       1234 Jan  1 12:34 opencode-limits-go/package.json",
    "-rw-r--r--  0 0      0        567 Jan  1  2023 opencode-limits-go/src/index.ts",
    "drwxr-xr-x  0 0      0          0 Jan  1 12:34 opencode-limits-go/src/",
  ].join("\n")
  assert.deepEqual(parseTarListing(bsdtar), { bytes: 1801, entries: 3 })
})

test("parseTarListing rejects links, escaping paths, oversized archives, and garbage", () => {
  const line = (mode: string, size: number, name: string) =>
    `${mode} root/root ${size} 2024-05-01 12:34 ${name}`
  assert.throws(() => parseTarListing(line("lrwxrwxrwx", 0, "link -> /etc/passwd")), /symbolic link/)
  assert.throws(() => parseTarListing(line("hrw-r--r--", 0, "hard")), /hard link/)
  assert.throws(() => parseTarListing(line("-rw-r--r--", 10, "/etc/passwd")), /escapes the install root/)
  assert.throws(() => parseTarListing(line("-rw-r--r--", 10, "../evil.ts")), /escapes the install root/)
  assert.throws(() => parseTarListing(line("-rw-r--r--", 10, "C:\\evil.ts")), /escapes the install root/)
  assert.throws(() => parseTarListing(line("-rw-r--r--", 10, "ok/file.ts"), 5), /too large/)
  assert.throws(() => parseTarListing("this is not a tar listing"), /Unparseable tar listing/)
  assert.throws(() => parseTarListing(""), /empty/)
})

test("parseZipListing parses unzip output and names-only output", () => {
  const unzip = [
    "Archive:  opencode-limits-go.zip",
    "  Length      Date    Time    Name",
    "---------  ---------- -----   ----",
    "     1234  2024-05-01 12:34   opencode-limits-go/package.json",
    "      567  2024-05-01 12:34   opencode-limits-go/src/index.ts",
    "---------                     -------",
    "     1801                     2 files",
  ].join("\n")
  assert.deepEqual(parseZipListing(unzip), { bytes: 1801, entries: 2 })

  const names = "opencode-limits-go/package.json\nopencode-limits-go/src/index.ts\n"
  assert.deepEqual(parseZipListing(names, { sizes: false }), { bytes: 0, entries: 2 })

  assert.throws(() => parseZipListing("../evil.ts\n", { sizes: false }), /escapes the install root/)
  assert.throws(() => parseZipListing(unzip, { maxBytes: 1 }), /too large/)
  assert.throws(() => parseZipListing("unexpected output", {}), /Unparseable zip listing/)
})

test("createUpdater does not cache a pending update for a dev install with autoInstall", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-dev-cache-"))
  try {
    await mkdir(path.join(tmp, ".git"), { recursive: true })
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.0.0" }))
    let fetches = 0
    const updater = createUpdater({
      pluginRoot: tmp,
      fetchFn: async () => {
        fetches++
        return new Response(
          JSON.stringify({
            tag_name: "v9.9.9",
            html_url: "https://github.com/cusvv/opencode-limits-go/releases/tag/v9.9.9",
          }),
          { status: 200 },
        )
      },
    })

    for (let i = 0; i < 3; i++) {
      const status = await updater.check({ autoInstall: true })
      assert.equal(status.managedByDev, true)
      assert.equal(status.updateAvailable, true)
    }
    assert.equal(fetches, 1)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("releaseIfOwned only removes a lock that carries its own token", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-lock-"))
  try {
    const lockPath = path.join(tmp, ".update.lock")
    await writeFile(lockPath, "other-owner")
    assert.equal(await readLockOwner(lockPath), "other-owner")
    assert.equal(await releaseIfOwned(lockPath, "mine"), false)
    assert.equal(await readLockOwner(lockPath), "other-owner")

    await writeFile(lockPath, "mine")
    assert.equal(await releaseIfOwned(lockPath, "mine"), true)
    assert.equal(await readLockOwner(lockPath), null)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("restorePlugin removes files added by a failed copy and replaces src wholesale", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-restore-"))
  try {
    const backup = path.join(tmp, "backup")
    const dest = path.join(tmp, "dest")
    await mkdir(path.join(backup, "src"), { recursive: true })
    await mkdir(path.join(dest, "src"), { recursive: true })
    await mkdir(path.join(dest, "dist"), { recursive: true })
    await writeFile(path.join(backup, "src", "index.ts"), "// old index")
    await writeFile(path.join(backup, "package.json"), JSON.stringify({ version: "1.0.0" }))
    await writeFile(path.join(dest, "src", "index.ts"), "// new index")
    await writeFile(path.join(dest, "src", "new.ts"), "// added by failed copy")
    await writeFile(path.join(dest, "dist", "gui-experimental.cjs"), "// added by failed copy")
    await writeFile(path.join(dest, "README.md"), "// added by failed copy")
    await writeFile(path.join(dest, "package.json"), JSON.stringify({ version: "9.9.9" }))

    await restorePlugin(backup, dest)

    assert.equal(await readFile(path.join(dest, "src", "index.ts"), "utf8"), "// old index")
    await assert.rejects(readFile(path.join(dest, "src", "new.ts"), "utf8"))
    await assert.rejects(readFile(path.join(dest, "dist", "gui-experimental.cjs"), "utf8"))
    await assert.rejects(readFile(path.join(dest, "README.md"), "utf8"))
    assert.equal(JSON.parse(await readFile(path.join(dest, "package.json"), "utf8")).version, "1.0.0")
    assert.equal(await readFile(path.join(backup, "src", "index.ts"), "utf8"), "// old index")
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("createUpdater refuses to extract when the archive listing cannot be verified", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-limits-go-inspect-test-"))
  try {
    await mkdir(path.join(tmp, "src"), { recursive: true })
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "opencode-limits-go", version: "1.5.0" }))
    let extracted = false
    const updater = createUpdater({
      pluginRoot: tmp,
      fetchFn: async (input) => {
        const url = String(input)
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.5.1",
              html_url: "https://github.com/cusvv/opencode-limits-go/releases/tag/v1.5.1",
              assets: [
                {
                  name: "opencode-limits-go.tar.gz",
                  browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/opencode-limits-go.tar.gz",
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url: "https://github.com/cusvv/opencode-limits-go/releases/download/v1.5.1/SHA256SUMS",
                },
              ],
            }),
            { status: 200 },
          )
        }
        if (url.endsWith("/SHA256SUMS")) {
          return new Response(`${ARCHIVE_HASH}  opencode-limits-go.tar.gz\n`, { status: 200 })
        }
        return new Response(ARCHIVE_BYTES, { status: 200 })
      },
      inspectFn: async () => {
        throw new Error("Archive contains a symbolic link")
      },
      extractFn: async () => {
        extracted = true
      },
    })

    const res = await updater.check({ force: true, autoInstall: true })
    assert.equal(res.autoUpdated, false)
    assert.equal(extracted, false)
    assert.match(res.error, /symbolic link/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// Captured verbatim from `C:/Windows/System32/tar.exe -tvzf` (bsdtar on Windows 10) and
// `tar.exe -tf` on this host; entry order is archive order.
const REAL_WIN_TAR_LISTING = [
  "drwxrwxrwx  0 0      0           0 Nov 25 02:23 opencode-limits-go/",
  "-rw-rw-rw-  0 0      0          13 Nov 25 02:23 opencode-limits-go/.gitignore",
  "drwxrwxrwx  0 0      0           0 Nov 25 02:23 opencode-limits-go/dist/",
  "drwxrwxrwx  0 0      0           0 Nov 25 02:23 opencode-limits-go/docs/",
  "-rw-rw-rw-  0 0      0          48 Nov 25 02:23 opencode-limits-go/package.json",
  "-rw-rw-rw-  0 0      0           9 Nov 25 02:23 opencode-limits-go/README.md",
  "drwxrwxrwx  0 0      0           0 Nov 25 02:23 opencode-limits-go/src/",
  "-rw-rw-rw-  0 0      0           9 Nov 25 02:23 opencode-limits-go/src/index.ts",
  "-rw-rw-rw-  0 0      0           7 Nov 25 02:23 opencode-limits-go/src/tui.tsx",
  "-rw-rw-rw-  0 0      0           4 Nov 25 02:23 opencode-limits-go/docs/a.png",
  "-rw-rw-rw-  0 0      0           7 Nov 25 02:23 opencode-limits-go/dist/gui-experimental.cjs",
].join("\n")

const REAL_WIN_ZIP_NAMES = [
  "opencode-limits-go/",
  "opencode-limits-go/.gitignore",
  "opencode-limits-go/dist/",
  "opencode-limits-go/docs/",
  "opencode-limits-go/package.json",
  "opencode-limits-go/README.md",
  "opencode-limits-go/src/",
  "opencode-limits-go/src/index.ts",
  "opencode-limits-go/src/tui.tsx",
  "opencode-limits-go/docs/a.png",
  "opencode-limits-go/dist/gui-experimental.cjs",
].join("\n")

// Captured verbatim from Git Bash `unzip -l` on this host: dates are MM-DD-YYYY, footer is indented.
const REAL_UNZIP_LISTING = [
  "Archive:  C:/Users/user/AppData/Local/Temp/test.zip",
  "  Length      Date    Time    Name",
  "---------  ---------- -----   ----",
  "        0  11-25-2026 02:23   opencode-limits-go/",
  "       13  11-25-2026 02:23   opencode-limits-go/.gitignore",
  "        0  11-25-2026 02:23   opencode-limits-go/dist/",
  "        0  11-25-2026 02:23   opencode-limits-go/docs/",
  "       48  11-25-2026 02:23   opencode-limits-go/package.json",
  "        9  11-25-2026 02:23   opencode-limits-go/README.md",
  "        0  11-25-2026 02:23   opencode-limits-go/src/",
  "        9  11-25-2026 02:23   opencode-limits-go/src/index.ts",
  "        7  11-25-2026 02:23   opencode-limits-go/src/tui.tsx",
  "        4  11-25-2026 02:23   opencode-limits-go/docs/a.png",
  "        7  11-25-2026 02:23   opencode-limits-go/dist/gui-experimental.cjs",
  " --------                     -------",
  "       97                     11 files",
].join("\n")

test("parseTarListing parses real Windows tar.exe output including directories", () => {
  assert.deepEqual(parseTarListing(REAL_WIN_TAR_LISTING), { bytes: 97, entries: 11 })
})

test("parseZipListing handles real tar.exe names and unzip MM-DD-YYYY output", () => {
  assert.deepEqual(parseZipListing(REAL_WIN_ZIP_NAMES, { sizes: false }), { bytes: 0, entries: 11 })
  assert.deepEqual(parseZipListing(REAL_UNZIP_LISTING, { sizes: true }), { bytes: 97, entries: 11 })
})

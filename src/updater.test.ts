import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  copyVerifiedPlugin,
  createUpdater,
  findVerifiedPluginRoot,
  isTrustedGitHubUrl,
  pickReleaseDownload,
} from "./updater.ts"

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
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      },
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

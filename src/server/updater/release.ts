export const REPO = "cusvv/opencode-limits-go"

export type GitHubRelease = {
  tag_name?: unknown
  html_url?: unknown
  tarball_url?: unknown
  zipball_url?: unknown
  assets?: unknown
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

export {
  REPO,
  isTrustedGitHubUrl,
  normalizeTagVersion,
  parseChecksum,
  pickChecksumAsset,
  pickReleaseDownload,
} from "./release.ts"
export type { GitHubRelease } from "./release.ts"
export { findVerifiedPluginRoot, parseTarListing, parseZipListing } from "./archive.ts"
export type { ArchiveListing } from "./archive.ts"
export { copyVerifiedPlugin, readLockOwner, releaseIfOwned, restorePlugin } from "./install.ts"
export { createUpdater, defaultPluginRoot, isDevInstall, isPackageManagerInstall } from "./check.ts"
export type { InstallResult, UpdateStatus, UpdaterDeps } from "./check.ts"

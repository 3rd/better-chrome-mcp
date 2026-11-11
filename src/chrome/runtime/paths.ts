import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserMode } from "./modes";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";
import { isIsolatedMode, isSharedMode } from "./modes";

export type ChromeOwnerKey = Readonly<{
  id: string;
  mode: BrowserMode;
  workspaceHash: string;
}>;

export type ChromeRuntimePaths = Readonly<{
  crashMarkerPath: string;
  downloadsPath: string;
  leasePath: string;
  metadataPath: string;
  ownerMetadataPath: string;
  profileRoot: string;
  runtimeRoot: string;
  userDataDir: string;
}>;

export type ChromeRuntimePathOptions = Readonly<{
  dataHome?: string;
  home?: string;
  runtimeRoot?: string;
}>;

export const workspaceIdentity = async (
  workspacePath: string,
): Promise<{ canonicalPath: string; hash: string }> => {
  const canonicalPath = await realpath(workspacePath);
  return {
    canonicalPath,
    hash: createHash("sha256").update(canonicalPath).digest("hex"),
  };
};

export const createOwnerKey = (
  mode: BrowserMode,
  workspaceHash: string,
  connectionId: string,
): ChromeOwnerKey => {
  const id = isIsolatedMode(mode) ? `${mode}:${workspaceHash}:${connectionId}` : `${mode}:${workspaceHash}`;
  return Object.freeze({ id, mode, workspaceHash });
};

const ownerDirectoryName = (key: ChromeOwnerKey): string =>
  createHash("sha256").update(key.id).digest("hex").slice(0, 32);

export const resolveChromeRuntimePaths = (
  key: ChromeOwnerKey,
  options: ChromeRuntimePathOptions = {},
): ChromeRuntimePaths => {
  const home = options.home ?? homedir();
  const dataHome = options.dataHome ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const runtimeRoot = join(options.runtimeRoot ?? getMcpRuntimeDir(), "chrome-mcp");
  const ownerName = ownerDirectoryName(key);
  const profileRoot =
    isSharedMode(key.mode) ?
      join(dataHome, "chrome-mcp", "profiles", key.workspaceHash, key.mode)
    : join(runtimeRoot, "chrome-profiles", ownerName);

  return Object.freeze({
    crashMarkerPath: join(profileRoot, "crash-marker.json"),
    downloadsPath: join(runtimeRoot, "chrome-artifacts", ownerName, "downloads"),
    leasePath: join(profileRoot, "profile.lease.json"),
    metadataPath: join(profileRoot, "metadata.json"),
    ownerMetadataPath: join(profileRoot, "owner.json"),
    profileRoot,
    runtimeRoot,
    userDataDir: join(profileRoot, "user-data"),
  });
};

export const resolveMainChromeUserDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const home = env.HOME ?? homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "Google", "Chrome", "User Data");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "google-chrome");
};

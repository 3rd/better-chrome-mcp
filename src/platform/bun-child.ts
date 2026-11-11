import { fileURLToPath } from "node:url";

// Bun loads bunfig.toml from a process's working directory, and child Bun processes can start in the
// user's workspace. Without this argument that workspace's settings, including its preload scripts,
// would run inside them. The argument names a shipped empty file because the null device is spelled
// differently on Windows.
export const ISOLATED_BUN_CONFIG_ARGUMENT = `--config=${fileURLToPath(new URL("./empty-bunfig.toml", import.meta.url))}`;

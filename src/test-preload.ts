import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "chrome-mcp-tests-"));
const dataHome = join(root, "data");
mkdirSync(dataHome, { recursive: true });
process.env.CHROME_MCP_RUNTIME_DIR = join(root, "runtime");
process.env.XDG_DATA_HOME = dataHome;

afterAll(() => rmSync(root, { recursive: true, force: true }));

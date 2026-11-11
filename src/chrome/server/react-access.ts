import { isToolSessionContext, type ToolSessionContext } from "../../mcp/session-context";
import { isReactProject } from "./react-project";

export const REACT_TOOLS_MODES = ["auto", "on", "off"] as const;

export type ReactToolsMode = (typeof REACT_TOOLS_MODES)[number];

export const createReactChromeToolsAccess = (mode: ReactToolsMode) => {
  return (session: ToolSessionContext): boolean => {
    if (!isToolSessionContext(session)) return false;
    if (mode === "on") return true;
    if (mode === "off") return false;

    try {
      return isReactProject(session.pathContext.baseCwd);
    } catch {
      return false;
    }
  };
};

import { REACT_PROFILE_MAX_BYTES } from "../runtime/react-inspection-protocol";

export const BROKER_DISCONNECT_GRACE_MS = 5000;
export const BROKER_PROTOCOL_VERSION = 16;
export const BROKER_CONNECT_BUDGET_MS = 10_000;
export const BROKER_INITIAL_IDLE_MS = BROKER_CONNECT_BUDGET_MS;
export const BROKER_SHUTDOWN_MAX_ATTEMPTS = 3;
export const BROKER_SHUTDOWN_RETRY_MS = 1000;
export const BROKER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const BROKER_REQUEST_TIMEOUT_MS = 30_000;
export const BROKER_ADMISSION_RESPONSE_GRACE_MS = 1000;
export const BROKER_FRAME_LENGTH_BYTES = 4;
export const BROKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Allows one maximum React profile response plus one frame while a local socket is backpressured or reassembling chunks. */
export const BROKER_MAX_QUEUED_WRITE_BYTES =
  REACT_PROFILE_MAX_BYTES + BROKER_FRAME_LENGTH_BYTES + BROKER_MAX_FRAME_BYTES;
export const BROKER_JSON_CHUNK_CHARACTERS = 256 * 1024;
export const BROKER_MAX_JSON_CHUNKS = 2048;

export const BROKER_CHILD_WORKSPACE_ENV = "CHROME_MCP_BROKER_WORKSPACE";
export const BROKER_CHILD_EXECUTABLE_ENV = "CHROME_MCP_BROKER_EXECUTABLE";
export const BROKER_CHILD_RUNTIME_ENV = "CHROME_MCP_BROKER_RUNTIME_DIR";

export const BROKER_METADATA_FILE = "broker.json";
export const BROKER_STARTUP_LOCK_FILE = "startup.lock";
export const BROKER_LOG_FILE = "broker.log";

export const BROKER_REQUEST_METHODS = [
  "broker.hello",
  "broker.status",
  "connection.close",
  "download.ack",
  "download.enable",
  "request.cancel",
  "session.acquire",
  "session.release",
  "session.snapshot",
  "admission.open",
  "admission.close",
  "owner.close.authorize",
  "owner.invalidate",
  "mutation.add",
  "mutation.clear",
  "mutation.list",
  "mutation.remove",
  "selection.begin",
  "selection.prepare",
  "selection.commit",
  "selection.select",
  "selection.rollback",
  "target.current",
  "target.ensure",
  "target.record",
  "journal.current",
  "journal.capabilities",
  "journal.mark",
  "journal.read",
  "journal.range",
  "modal.dialog",
  "modal.fileChooser",
  "modal.requireNone",
  "modal.handleDialog",
  "modal.setFileChooserFiles",
  "cdp.send",
  "page.viewport",
  "pwa.execute",
  "cdp.subscribe",
  "cdp.unsubscribe",
  "worker.connection",
  "react.execute",
] as const;

export type BrokerRequestMethod = (typeof BROKER_REQUEST_METHODS)[number];

import { randomUUID } from "node:crypto";
import type { GenerationTargetId } from "./target-registry";
import { ChromeRuntimeError } from "./errors";

export type ActiveDialog = Readonly<{
  defaultValue: string;
  dialogId: string;
  dialogType: string;
  message: string;
  ownerGeneration: number;
  sessionId: string;
  targetId: string;
}>;

export type ActiveFileChooser = Readonly<{
  accept?: string;
  backendNodeId: number;
  chooserId: string;
  multiple: boolean;
  ownerGeneration: number;
  sessionId: string;
  targetId: string;
}>;

export type BlockingModal =
  | Readonly<{ dialog: ActiveDialog; type: "dialog" }>
  | Readonly<{ fileChooser: ActiveFileChooser; type: "file_chooser" }>;

export class ActiveModalRegistry {
  readonly ownerGeneration: number;

  #dialogs = new Map<string, ActiveDialog>();
  #fileChoosers = new Map<string, ActiveFileChooser>();

  constructor(ownerGeneration: number) {
    this.ownerGeneration = ownerGeneration;
  }

  openDialog(
    target: GenerationTargetId,
    sessionId: string,
    input: Readonly<{ defaultValue: string; dialogType: string; message: string }>,
  ): ActiveDialog {
    this.#requireGeneration(target);
    const dialog = Object.freeze({
      ...input,
      dialogId: randomUUID(),
      ownerGeneration: this.ownerGeneration,
      sessionId,
      targetId: target.targetId,
    });
    this.#dialogs.set(target.targetId, dialog);
    return dialog;
  }

  dialog(target: GenerationTargetId): ActiveDialog | undefined {
    this.#requireGeneration(target);
    return this.#dialogs.get(target.targetId);
  }

  closeDialog(target: GenerationTargetId, dialogId: string): ActiveDialog {
    this.#requireGeneration(target);
    const dialog = this.#dialogs.get(target.targetId);
    if (!dialog || dialog.dialogId !== dialogId) {
      throw new ChromeRuntimeError("CHROME_MCP_STALE_MODAL", "The JavaScript dialog is no longer active");
    }
    this.#dialogs.delete(target.targetId);
    return dialog;
  }

  openFileChooser(
    target: GenerationTargetId,
    sessionId: string,
    input: Readonly<{ accept?: string; backendNodeId: number; multiple: boolean }>,
  ): ActiveFileChooser {
    this.#requireGeneration(target);
    const chooser = Object.freeze({
      ...input,
      chooserId: randomUUID(),
      ownerGeneration: this.ownerGeneration,
      sessionId,
      targetId: target.targetId,
    });
    this.#fileChoosers.set(target.targetId, chooser);
    return chooser;
  }

  fileChooser(target: GenerationTargetId): ActiveFileChooser | undefined {
    this.#requireGeneration(target);
    return this.#fileChoosers.get(target.targetId);
  }

  blockingModal(target: GenerationTargetId): BlockingModal | undefined {
    this.#requireGeneration(target);
    const dialog = this.#dialogs.get(target.targetId);
    if (dialog) return Object.freeze({ dialog, type: "dialog" });
    const fileChooser = this.#fileChoosers.get(target.targetId);
    return fileChooser ? Object.freeze({ fileChooser, type: "file_chooser" }) : undefined;
  }

  requireUnblocked(target: GenerationTargetId): void {
    const blocking = this.blockingModal(target);
    if (!blocking) return;
    const id = blocking.type === "dialog" ? blocking.dialog.dialogId : blocking.fileChooser.chooserId;
    throw new ChromeRuntimeError(
      "CHROME_MCP_BLOCKING_MODAL",
      `Chrome target ${target.targetId} has an active ${blocking.type} (${id})`,
    );
  }

  closeFileChooser(target: GenerationTargetId, chooserId: string): ActiveFileChooser {
    this.#requireGeneration(target);
    const chooser = this.#fileChoosers.get(target.targetId);
    if (!chooser || chooser.chooserId !== chooserId) {
      throw new ChromeRuntimeError("CHROME_MCP_STALE_MODAL", "The file chooser is no longer active");
    }
    this.#fileChoosers.delete(target.targetId);
    return chooser;
  }

  clearTarget(targetId: string): void {
    this.#dialogs.delete(targetId);
    this.#fileChoosers.delete(targetId);
  }

  #requireGeneration(target: GenerationTargetId): void {
    if (target.ownerGeneration !== this.ownerGeneration) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_MODAL",
        "The modal belongs to an older browser generation",
      );
    }
  }
}

import { z } from "zod/v4";
import { ChromeRuntimeError } from "./errors";

export const unavailableTargetSchema = z
  .object({
    targetId: z.string().min(1),
    error: z.string().min(1),
  })
  .strict();

export type UnavailableTarget = z.infer<typeof unavailableTargetSchema>;

export type GenerationTargetId = Readonly<{
  ownerGeneration: number;
  targetId: string;
}>;

export type ChromeTargetRecord = Readonly<{
  activatedSequence: number;
  closed: boolean;
  creationSequence: number;
  openerTargetId?: string;
  ownerGeneration: number;
  targetId: string;
  title?: string;
  url: string;
}>;

export type ChromeTargetInput = Readonly<{
  openerTargetId?: string;
  targetId: string;
  title?: string;
  url: string;
}>;

const targetKey = (target: GenerationTargetId): string => `${target.ownerGeneration}:${target.targetId}`;

export class ChromeTargetRegistry {
  readonly ownerGeneration: number;

  #activationSequence = 0;
  #creationSequence = 0;
  #readyTargetIds = new Set<string>();
  #records = new Map<string, ChromeTargetRecord>();
  private unavailableTargetErrors = new Map<string, string>();

  constructor(ownerGeneration: number) {
    if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
      throw new Error("Owner generation must be positive");
    }
    this.ownerGeneration = ownerGeneration;
  }

  get creationSequence(): number {
    return this.#creationSequence;
  }

  beginArming(input: ChromeTargetInput): ChromeTargetRecord {
    if (!input.targetId) throw new Error("Chrome target ID must not be blank");
    this.unavailableTargetErrors.delete(input.targetId);
    const existing = this.#records.get(input.targetId);
    if (existing && !existing.closed) {
      this.#readyTargetIds.delete(input.targetId);
      return this.update(input.targetId, input);
    }
    this.#creationSequence++;
    const record = Object.freeze({
      activatedSequence: 0,
      closed: false,
      creationSequence: this.#creationSequence,
      ...(input.openerTargetId ? { openerTargetId: input.openerTargetId } : {}),
      ownerGeneration: this.ownerGeneration,
      targetId: input.targetId,
      ...(input.title === undefined ? {} : { title: input.title }),
      url: input.url,
    });
    this.#records.set(input.targetId, record);
    return record;
  }

  update(targetId: string, input: Partial<Omit<ChromeTargetInput, "targetId">>): ChromeTargetRecord {
    const current = this.#records.get(targetId);
    if (!current || current.closed) {
      throw new ChromeRuntimeError("CHROME_MCP_UNKNOWN_TARGET", `Unknown Chrome target ${targetId}`);
    }
    const record = Object.freeze({
      ...current,
      ...(input.openerTargetId === undefined ? {} : { openerTargetId: input.openerTargetId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.url === undefined ? {} : { url: input.url }),
    });
    this.#records.set(targetId, record);
    return record;
  }

  activate(targetId: string): ChromeTargetRecord {
    const current = this.require({ ownerGeneration: this.ownerGeneration, targetId });
    this.#activationSequence++;
    const record = Object.freeze({ ...current, activatedSequence: this.#activationSequence });
    this.#records.set(targetId, record);
    return record;
  }

  close(targetId: string): ChromeTargetRecord | undefined {
    this.unavailableTargetErrors.delete(targetId);
    const current = this.#records.get(targetId);
    if (!current || current.closed) return undefined;
    this.#readyTargetIds.delete(targetId);
    const record = Object.freeze({ ...current, closed: true });
    this.#records.set(targetId, record);
    return record;
  }

  get(target: GenerationTargetId): ChromeTargetRecord | undefined {
    if (target.ownerGeneration !== this.ownerGeneration) return undefined;
    const record = this.#records.get(target.targetId);
    return record?.closed ? undefined : record;
  }

  record(targetId: string): ChromeTargetRecord | undefined {
    return this.#records.get(targetId);
  }

  require(target: GenerationTargetId): ChromeTargetRecord {
    if (target.ownerGeneration !== this.ownerGeneration) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_TARGET",
        `Chrome target ${target.targetId} belongs to owner generation ${target.ownerGeneration}, not ${this.ownerGeneration}`,
      );
    }
    const record = this.get(target);
    if (!record) {
      throw new ChromeRuntimeError("CHROME_MCP_UNKNOWN_TARGET", `Unknown Chrome target ${target.targetId}`);
    }
    return record;
  }

  markReady(targetId: string): ChromeTargetRecord {
    const record = this.require({ ownerGeneration: this.ownerGeneration, targetId });
    this.unavailableTargetErrors.delete(targetId);
    this.#readyTargetIds.add(targetId);
    return record;
  }

  markUnavailable(targetId: string, error: string) {
    this.require({ ownerGeneration: this.ownerGeneration, targetId });
    this.#readyTargetIds.delete(targetId);
    this.unavailableTargetErrors.set(targetId, error);
  }

  unavailableReason(targetId: string) {
    return this.unavailableTargetErrors.get(targetId);
  }

  unavailableTargets() {
    return [...this.unavailableTargetErrors].map(([targetId, error]) => ({ targetId, error }));
  }

  ready(target: GenerationTargetId): ChromeTargetRecord | undefined {
    const record = this.get(target);
    return record && this.#readyTargetIds.has(target.targetId) ? record : undefined;
  }

  requireReady(target: GenerationTargetId): ChromeTargetRecord {
    const record = this.require(target);
    if (!this.#readyTargetIds.has(target.targetId)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_UNKNOWN_TARGET",
        `Chrome target ${target.targetId} is not ready`,
      );
    }
    return record;
  }

  identity(targetId: string): GenerationTargetId {
    this.require({ ownerGeneration: this.ownerGeneration, targetId });
    return Object.freeze({ ownerGeneration: this.ownerGeneration, targetId });
  }

  liveRecords(): ChromeTargetRecord[] {
    return [...this.#records.values()]
      .filter((record) => !record.closed)
      .sort((left, right) => left.creationSequence - right.creationSequence);
  }

  readyRecords(): ChromeTargetRecord[] {
    return this.liveRecords().filter((record) => this.#readyTargetIds.has(record.targetId));
  }

  first(): GenerationTargetId | undefined {
    const record = this.readyRecords()[0];
    return record ? this.identity(record.targetId) : undefined;
  }

  mostRecentlyActive(): GenerationTargetId | undefined {
    const records = this.readyRecords().filter((record) => record.activatedSequence > 0);
    records.sort(
      (left, right) =>
        right.activatedSequence - left.activatedSequence || right.creationSequence - left.creationSequence,
    );
    const record = records[0];
    return record ? this.identity(record.targetId) : undefined;
  }

  nearestSurvivor(creationSequence: number): GenerationTargetId | undefined {
    const records = this.readyRecords();
    let best: ChromeTargetRecord | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const record of records) {
      const distance = Math.abs(record.creationSequence - creationSequence);
      if (
        distance < bestDistance ||
        (distance === bestDistance && record.creationSequence < (best?.creationSequence ?? Infinity))
      ) {
        best = record;
        bestDistance = distance;
      }
    }
    return best ? this.identity(best.targetId) : undefined;
  }
}

export class SelectionTransaction {
  readonly initialTarget: GenerationTargetId;
  readonly startCreationSequence: number;

  #clientId: string;
  #createdTargets = new Map<string, GenerationTargetId>();
  #explicit: GenerationTargetId | undefined;
  private prepared: GenerationTargetId | undefined;
  #finished = false;
  #registry: ChromeTargetRegistry;
  #store: ClientSelectionStore;

  constructor(
    store: ClientSelectionStore,
    registry: ChromeTargetRegistry,
    clientId: string,
    initialTarget: GenerationTargetId,
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#clientId = clientId;
    this.initialTarget = Object.freeze({ ...initialTarget });
    this.startCreationSequence = registry.creationSequence;
  }

  select(target: GenerationTargetId): void {
    if (this.#finished) throw new Error("Selection transaction has finished");
    this.#registry.requireReady(target);
    this.#explicit = Object.freeze({ ...target });
  }

  recordCreated(target: GenerationTargetId): void {
    if (this.#finished) throw new Error("Selection transaction has finished");
    const record = this.#registry.requireReady(target);
    if (record.creationSequence <= this.startCreationSequence) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_TARGET",
        `Chrome target ${target.targetId} was not created by this call`,
      );
    }
    this.#createdTargets.set(targetKey(target), Object.freeze({ ...target }));
  }

  prepare() {
    if (this.#finished) {
      throw new Error("Selection transaction has finished");
    }

    if (this.prepared) return this.prepared;

    const selected =
      (this.#explicit && this.#registry.ready(this.#explicit) ? this.#explicit : undefined) ??
      this.#newestCreatedTarget() ??
      (this.#registry.ready(this.initialTarget) ? this.initialTarget : undefined) ??
      this.#fallback();
    this.prepared = selected;
    return selected;
  }

  commit(): GenerationTargetId {
    if (this.#finished) {
      throw new Error("Selection transaction has finished");
    }

    const selected = this.prepare();
    this.#store.commit(this.#clientId, selected);
    this.#finished = true;
    return selected;
  }

  rollback(): GenerationTargetId {
    if (this.#finished) throw new Error("Selection transaction has finished");
    const selected = this.#registry.ready(this.initialTarget) ? this.initialTarget : this.#fallback();
    this.#store.commit(this.#clientId, selected);
    this.#finished = true;
    return selected;
  }

  #fallback(): GenerationTargetId {
    const initialRecord = this.#registry.record(this.initialTarget.targetId);
    const nearest = this.#registry.nearestSurvivor(
      initialRecord?.creationSequence ?? this.startCreationSequence,
    );
    const fallback = nearest ?? this.#registry.first();
    if (!fallback) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_UNKNOWN_TARGET",
        "No usable page remains to select after this call. Browser actions, including page closure, were not undone. Do not retry a completed close; leave the prebound page open when finishing a task.",
      );
    }
    return fallback;
  }

  #newestCreatedTarget(): GenerationTargetId | undefined {
    let selected: GenerationTargetId | undefined;
    let selectedSequence = 0;
    for (const target of this.#createdTargets.values()) {
      const record = this.#registry.ready(target);
      if (record && record.creationSequence > selectedSequence) {
        selected = target;
        selectedSequence = record.creationSequence;
      }
    }
    return selected;
  }
}

export class ClientSelectionStore {
  #registry: ChromeTargetRegistry;
  #selected = new Map<string, GenerationTargetId>();

  constructor(registry: ChromeTargetRegistry) {
    this.#registry = registry;
  }

  addClient(clientId: string): GenerationTargetId {
    const current = this.#selected.get(clientId);
    if (current && this.#registry.ready(current)) return current;
    const selected = this.#registry.mostRecentlyActive() ?? this.#registry.first();
    if (!selected) {
      throw new ChromeRuntimeError("CHROME_MCP_UNKNOWN_TARGET", "Chrome browser has no normal page target");
    }
    this.#selected.set(clientId, selected);
    return selected;
  }

  removeClient(clientId: string): void {
    this.#selected.delete(clientId);
  }

  clientsSelecting(target: GenerationTargetId): string[] {
    const clients: string[] = [];
    for (const [clientId, selected] of this.#selected) {
      if (selected.ownerGeneration === target.ownerGeneration && selected.targetId === target.targetId) {
        clients.push(clientId);
      }
    }
    return clients;
  }

  recoverableSelection(clientId: string): GenerationTargetId | undefined {
    const selected = this.#selected.get(clientId);
    return selected && this.#registry.ready(selected) ? selected : undefined;
  }

  selected(clientId: string): GenerationTargetId {
    const selected = this.#selected.get(clientId) ?? this.addClient(clientId);
    const ready = this.#registry.ready(selected);
    if (ready) return selected;
    const prior = this.#registry.record(selected.targetId);
    const fallback =
      this.#registry.nearestSurvivor(prior?.creationSequence ?? this.#registry.creationSequence) ??
      this.#registry.first();
    if (!fallback) {
      throw new ChromeRuntimeError("CHROME_MCP_UNKNOWN_TARGET", "Chrome browser has no normal page target");
    }
    this.#selected.set(clientId, fallback);
    return fallback;
  }

  onTargetClosed(record: ChromeTargetRecord): void {
    for (const [clientId, selected] of this.#selected) {
      if (selected.ownerGeneration !== record.ownerGeneration || selected.targetId !== record.targetId) {
        continue;
      }
      const fallback = this.#registry.nearestSurvivor(record.creationSequence) ?? this.#registry.first();
      if (fallback) this.#selected.set(clientId, fallback);
      else this.#selected.delete(clientId);
    }
  }

  begin(clientId: string): SelectionTransaction {
    return new SelectionTransaction(this, this.#registry, clientId, this.selected(clientId));
  }

  commit(clientId: string, selected: GenerationTargetId): void {
    this.#registry.requireReady(selected);
    this.#selected.set(clientId, selected);
  }
}

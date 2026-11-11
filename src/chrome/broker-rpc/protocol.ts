import { z } from "zod/v4";
import { nativeDeviceScaleFactorSchema } from "../browser-modes";
import {
  BROWSER_MODES,
  JOURNAL_EVENT_TYPES,
  JOURNAL_READ_MAX_LIMIT,
  JOURNAL_READ_MIN_LIMIT,
  persistentMutationEntrySchema,
  persistentMutationInputSchema,
  persistentMutationKindSchema,
} from "../runtime";
import { consoleStackTraceSchema } from "../runtime/event-journal";
import { pageViewportRequestSchema, pageViewportStateSchema } from "../runtime/page-viewport";
import { pwaOperationSchema, pwaResultSchema } from "../runtime/pwa-controller";
import {
  reactBrowserOperationSchema,
  reactOperationResultSchema,
} from "../runtime/react-inspection-protocol";
import { unavailableTargetSchema } from "../runtime/target-registry";
import { BROKER_MAX_JSON_CHUNKS, BROKER_REQUEST_METHODS } from "./constants";

const jsonObjectSchema = z.record(z.string(), z.json());
const privateEndpointSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("ws://127.0.0.1:") || value.startsWith("wss://127.0.0.1:"));
const identifierSchema = z.string().uuid();
export const brokerConnectionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "Connection ID must not have leading or trailing whitespace");
const sequenceSchema = z.number().int().nonnegative();

export const browserModeSchema = z.enum(BROWSER_MODES);
export const brokerRequestMethodSchema = z.enum(BROKER_REQUEST_METHODS);

export const targetIdentitySchema = z
  .object({
    ownerGeneration: z.number().int().positive(),
    targetId: z.string().min(1),
  })
  .strict();

export const eventCursorSchema = z
  .object({
    ownerGeneration: z.number().int().positive(),
    sequence: sequenceSchema,
  })
  .strict();

const boundedTextSchema = z
  .object({
    originalBytes: z.number().int().nonnegative(),
    preview: z.string(),
    previewTruncated: z.boolean(),
  })
  .strict();

const journalHeadersSchema = z.record(z.string(), boundedTextSchema);
const journalBaseSchema = z.object({
  monotonicTime: z.number().finite().nonnegative(),
  ownerGeneration: z.number().int().positive(),
  sequence: z.number().int().positive(),
  targetId: z.string().min(1),
  wallTime: z.iso.datetime(),
});

export const targetCrashEventSchema = journalBaseSchema
  .extend({
    errorCode: z.number().int(),
    status: boundedTextSchema,
    type: z.literal("target_crashed"),
  })
  .strict();

export const journalEventSchema = z.discriminatedUnion("type", [
  targetCrashEventSchema,
  journalBaseSchema
    .extend({
      argumentPreviews: z.array(boundedTextSchema),
      column: z.number().int().nonnegative().optional(),
      level: z.string(),
      line: z.number().int().nonnegative().optional(),
      sourceUrl: z.string().optional(),
      stackTrace: consoleStackTraceSchema.optional(),
      text: boundedTextSchema,
      type: z.literal("console"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      message: boundedTextSchema,
      name: z.string(),
      stack: boundedTextSchema.optional(),
      type: z.literal("page_error"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      headers: journalHeadersSchema,
      isNavigation: z.boolean(),
      method: z.string(),
      requestId: z.string(),
      resourceType: z.string(),
      type: z.literal("request"),
      url: z.string(),
    })
    .strict(),
  journalBaseSchema
    .extend({
      encodedDataLength: z.number().finite().nonnegative().optional(),
      headers: journalHeadersSchema,
      requestId: z.string(),
      status: z.number().finite(),
      statusText: z.string(),
      type: z.literal("response"),
      url: z.string(),
    })
    .strict(),
  journalBaseSchema
    .extend({
      failureText: boundedTextSchema,
      requestId: z.string(),
      type: z.literal("request_failed"),
      url: z.string().optional(),
    })
    .strict(),
  journalBaseSchema
    .extend({
      socketId: z.string(),
      type: z.literal("websocket_open"),
      url: z.string(),
    })
    .strict(),
  journalBaseSchema
    .extend({
      binaryBytes: z.number().int().nonnegative().optional(),
      binaryHexPreview: z.string().optional(),
      opcode: z.number().int(),
      socketId: z.string(),
      text: boundedTextSchema.optional(),
      type: z.enum(["websocket_frame_received", "websocket_frame_sent"]),
    })
    .strict(),
  journalBaseSchema
    .extend({
      error: boundedTextSchema,
      socketId: z.string(),
      type: z.literal("websocket_error"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      socketId: z.string(),
      type: z.literal("websocket_closed"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      openerTargetId: z.string().optional(),
      popupTargetId: z.string(),
      type: z.literal("popup"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      downloadId: z.string(),
      suggestedFilename: z.string(),
      type: z.literal("download_started"),
      url: z.string(),
    })
    .strict(),
  journalBaseSchema
    .extend({
      artifactUri: z.string().optional(),
      byteCount: z.number().int().nonnegative().optional(),
      downloadId: z.string(),
      failureText: boundedTextSchema.optional(),
      status: z.enum(["canceled", "completed", "failed"]),
      type: z.literal("download_finished"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      defaultValue: z.string(),
      dialogId: z.string().min(1),
      dialogType: z.string(),
      message: boundedTextSchema,
      type: z.literal("dialog_opened"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      accepted: z.boolean(),
      dialogId: z.string().min(1),
      promptText: z.string().optional(),
      type: z.literal("dialog_closed"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      accept: z.string().optional(),
      chooserId: z.string().min(1),
      multiple: z.boolean(),
      type: z.literal("file_chooser_opened"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      chooserId: z.string().min(1),
      type: z.literal("file_chooser_closed"),
    })
    .strict(),
  journalBaseSchema
    .extend({
      measuredBytes: z.number().int().nonnegative(),
      originalType: z.enum(JOURNAL_EVENT_TYPES),
      type: z.literal("journal_drop"),
    })
    .strict(),
]);

export const journalReadOptionsSchema = z
  .object({
    advance: z.boolean().optional(),
    after: eventCursorSchema.optional(),
    includeStackTraces: z.boolean().optional(),
    limit: z.number().int().min(JOURNAL_READ_MIN_LIMIT).max(JOURNAL_READ_MAX_LIMIT).optional(),
    target: z.string().min(1).optional(),
    types: z.array(z.enum(JOURNAL_EVENT_TYPES)).max(JOURNAL_EVENT_TYPES.length).optional(),
  })
  .strict();

export const journalReadResultSchema = z
  .object({
    droppedBefore: eventCursorSchema.nullable(),
    events: z.array(journalEventSchema),
    nextCursor: eventCursorSchema,
    ownerReset: z.boolean(),
  })
  .strict();

export const ownerSnapshotSchema = z
  .object({
    browserConnected: z.boolean(),
    chromeProduct: z.string().optional(),
    clients: z.number().int().nonnegative(),
    endpointAvailable: z.literal(true),
    headless: z.boolean(),
    nativeDeviceScaleFactor: nativeDeviceScaleFactorSchema.optional(),
    key: z
      .object({
        id: z.string().min(1),
        mode: browserModeSchema,
        workspaceHash: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    ownerGeneration: z.number().int().positive(),
    ownership: z.enum(["attached", "launched"]),
    selectedTargets: z.number().int().nonnegative(),
    unavailableTargets: z.array(unavailableTargetSchema).optional(),
  })
  .strict();

export const activeDialogSchema = z
  .object({
    defaultValue: z.string(),
    dialogId: z.string().min(1),
    dialogType: z.string(),
    message: z.string(),
    ownerGeneration: z.number().int().positive(),
    sessionId: z.string().min(1),
    targetId: z.string().min(1),
  })
  .strict();

export const activeFileChooserSchema = z
  .object({
    accept: z.string().optional(),
    backendNodeId: z.number().int().nonnegative(),
    chooserId: z.string().min(1),
    multiple: z.boolean(),
    ownerGeneration: z.number().int().positive(),
    sessionId: z.string().min(1),
    targetId: z.string().min(1),
  })
  .strict();

export const brokerRequestSchema = z
  .object({
    id: identifierSchema,
    kind: z.literal("request"),
    method: brokerRequestMethodSchema,
    params: z.json(),
  })
  .strict();

const wireErrorSchema = z
  .object({
    cdpCode: z.number().int().optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const brokerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: identifierSchema,
      kind: z.literal("response"),
      ok: z.literal(true),
      result: z.json(),
    })
    .strict(),
  z
    .object({
      error: wireErrorSchema,
      id: identifierSchema,
      kind: z.literal("response"),
      ok: z.literal(false),
    })
    .strict(),
]);

export const brokerResponseChunkSchema = z
  .object({
    chunk: z.string(),
    chunkCount: z.number().int().positive().max(BROKER_MAX_JSON_CHUNKS),
    chunkIndex: z.number().int().nonnegative(),
    id: identifierSchema,
    kind: z.literal("response.chunk"),
  })
  .strict()
  .refine((value) => value.chunkIndex < value.chunkCount, "Response chunk index must be below chunk count");

export const brokerNotificationSchema = z.discriminatedUnion("notification", [
  z
    .object({
      browserMode: browserModeSchema,
      connectionId: brokerConnectionIdSchema,
      downloadId: z.string().min(1),
      notification: z.literal("download.finished"),
      ownerGeneration: z.number().int().positive(),
      path: z.string().min(1),
      publicationId: identifierSchema,
      suggestedFilename: z.string().optional(),
      targetId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      eventMethod: z.string().min(1),
      notification: z.literal("cdp.event"),
      params: z.json(),
      sessionId: z.string().min(1).nullable(),
      subscriptionId: identifierSchema,
    })
    .strict(),
  z
    .object({
      chunk: z.string(),
      chunkCount: z.number().int().positive().max(BROKER_MAX_JSON_CHUNKS),
      chunkIndex: z.number().int().nonnegative(),
      eventMethod: z.string().min(1),
      notification: z.literal("cdp.event.chunk"),
      sessionId: z.string().min(1).nullable(),
      subscriptionId: identifierSchema,
      transmissionId: identifierSchema,
    })
    .strict()
    .refine((value) => value.chunkIndex < value.chunkCount, "CDP chunk index must be below chunk count"),
  z
    .object({
      admissionRequestId: identifierSchema,
      notification: z.literal("admission.progress"),
      phase: z.enum(["queued", "admitted", "completed", "canceled"]),
      position: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export type BrokerNotification = z.infer<typeof brokerNotificationSchema>;

export const downloadPublicationSchema = z
  .object({
    artifactUri: z.string().min(1).optional(),
    byteCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const sessionParams = {
  admissionToken: identifierSchema,
  sessionId: identifierSchema,
};

export const brokerParams = Object.freeze({
  hello: z
    .object({
      connectionId: brokerConnectionIdSchema,
      protocolVersion: z.number().int().positive(),
      workspaceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  status: z.object({}).strict(),
  connectionClose: z.object({}).strict(),
  downloadAck: z
    .object({
      outcome: z.discriminatedUnion("status", [
        z
          .object({
            publication: downloadPublicationSchema,
            status: z.literal("published"),
          })
          .strict(),
        z.object({ status: z.literal("failed") }).strict(),
      ]),
      publicationId: identifierSchema,
    })
    .strict(),
  requestCancel: z.object({ requestId: identifierSchema }).strict(),
  sessionAcquire: z
    .object({
      mode: browserModeSchema,
      mainUserDataDir: z.string().min(1).optional(),
      nativeDeviceScaleFactor: nativeDeviceScaleFactorSchema.optional(),
    })
    .strict(),
  sessionRelease: z.object({ sessionId: sessionParams.sessionId }).strict(),
  sessionSnapshot: z.object({ sessionId: sessionParams.sessionId }).strict(),
  admissionOpen: z
    .object({
      deadlineAt: z.number().int().positive().optional(),
      modalPolicy: z.enum(["allow", "reject"]).default("allow"),
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  admissionClose: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  ownerCloseAuthorize: z
    .object({
      admissionToken: sessionParams.admissionToken,
      resource: z.enum(["browser", "default-context"]),
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  ownerInvalidate: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  mutationAdd: z
    .object({
      admissionToken: sessionParams.admissionToken,
      input: persistentMutationInputSchema,
      sessionId: sessionParams.sessionId,
      target: targetIdentitySchema,
    })
    .strict(),
  mutationClear: z
    .object({
      admissionToken: sessionParams.admissionToken,
      kind: persistentMutationKindSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  mutationList: z
    .object({
      admissionToken: sessionParams.admissionToken,
      kind: persistentMutationKindSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  mutationRemove: z
    .object({
      admissionToken: sessionParams.admissionToken,
      id: z.string().min(1).max(128),
      kind: persistentMutationKindSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  selectionBegin: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  selectionCommit: z
    .object({
      admissionToken: sessionParams.admissionToken,
      createdTargets: z.array(targetIdentitySchema).max(256),
      sessionId: sessionParams.sessionId,
      transactionId: identifierSchema,
    })
    .strict(),
  selectionSelect: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
      target: targetIdentitySchema,
      transactionId: identifierSchema,
    })
    .strict(),
  selectionRollback: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
      transactionId: identifierSchema,
    })
    .strict(),
  admittedSession: z
    .object({
      admissionToken: sessionParams.admissionToken,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  sessionOnly: z.object({ sessionId: sessionParams.sessionId }).strict(),
  targetRecord: z
    .object({
      sessionId: sessionParams.sessionId,
      targetId: z.string().min(1),
    })
    .strict(),
  journalRead: z
    .object({
      options: journalReadOptionsSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  journalRange: z
    .object({
      after: eventCursorSchema,
      sessionId: sessionParams.sessionId,
      targetId: z.string().min(1),
    })
    .strict(),
  modalHandleDialog: z
    .object({
      accept: z.boolean(),
      admissionToken: sessionParams.admissionToken,
      dialogId: z.string().min(1),
      promptText: z.string().optional(),
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  modalSetFileChooserFiles: z
    .object({
      admissionToken: sessionParams.admissionToken,
      chooserId: z.string().min(1),
      files: z.array(z.string().min(1)).max(1000),
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  cdpSend: z
    .object({
      admissionToken: sessionParams.admissionToken,
      method: z.string().min(1),
      params: jsonObjectSchema.optional(),
      sessionId: sessionParams.sessionId,
      targetSessionId: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1).max(300_000).optional(),
    })
    .strict(),
  pageViewport: z
    .object({
      admissionToken: sessionParams.admissionToken,
      request: pageViewportRequestSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  pwaExecute: z
    .object({
      admissionToken: sessionParams.admissionToken,
      input: pwaOperationSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
  cdpSubscribe: z
    .object({
      eventMethod: z.string().min(1),
      sessionId: sessionParams.sessionId,
      subscriptionId: identifierSchema,
    })
    .strict(),
  cdpUnsubscribe: z.object({ subscriptionId: identifierSchema }).strict(),
  reactExecute: z
    .object({
      admissionToken: sessionParams.admissionToken,
      input: reactBrowserOperationSchema,
      sessionId: sessionParams.sessionId,
    })
    .strict(),
});

const selectionPreparationSchema = z
  .object({
    hasBlockingDialog: z.boolean(),
    target: targetIdentitySchema,
  })
  .strict();

export type PreparedSelection = z.output<typeof selectionPreparationSchema>;

export const brokerResults = Object.freeze({
  selectionPreparation: selectionPreparationSchema,
  pwaExecute: pwaResultSchema,
  pageViewport: pageViewportStateSchema,
  hello: z
    .object({
      brokerId: identifierSchema,
      brokerPid: z.number().int().positive(),
      processStartIdentity: z.string().min(1),
      protocolVersion: z.number().int().positive(),
      workspaceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  status: z
    .object({
      activeAdmissions: z.number().int().nonnegative(),
      brokerId: identifierSchema,
      brokerPid: z.number().int().positive(),
      connections: z.number().int().nonnegative(),
      sessions: z.number().int().nonnegative(),
      workspaceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  ok: z.object({ ok: z.literal(true) }).strict(),
  acquired: z
    .object({
      mode: browserModeSchema,
      ownerGeneration: z.number().int().positive(),
      ownerId: z.string().min(1),
      sessionId: identifierSchema,
      snapshot: ownerSnapshotSchema,
      target: targetIdentitySchema,
    })
    .strict(),
  admission: z
    .object({
      admissionToken: identifierSchema,
      dialog: activeDialogSchema.nullable(),
      fileChooser: activeFileChooserSchema.nullable(),
      ownerGeneration: z.number().int().positive(),
      target: targetIdentitySchema,
    })
    .strict(),
  selection: z
    .object({
      initialTarget: targetIdentitySchema,
      transactionId: identifierSchema,
    })
    .strict(),
  mutationEntry: persistentMutationEntrySchema,
  mutationEntries: z.array(persistentMutationEntrySchema),
  targetRecord: z.object({ title: z.string().optional(), url: z.string() }).strict().nullable(),
  journalCapabilities: z
    .object({
      currentSequence: sequenceSchema,
      eventCount: z.number().int().nonnegative(),
      firstRetainedSequence: z.number().int().positive(),
      retainedBytes: z.number().int().nonnegative(),
    })
    .strict(),
  dialog: activeDialogSchema.nullable(),
  workerConnection: z
    .object({
      downloadsPath: z.string().min(1).optional(),
      endpoint: privateEndpointSchema,
      executionEndpoint: privateEndpointSchema,
      ownerGeneration: z.number().int().positive(),
      target: targetIdentitySchema,
    })
    .strict(),
  reactOperation: reactOperationResultSchema,
});

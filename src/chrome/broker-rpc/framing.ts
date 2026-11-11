import { z } from "zod/v4";
import { BROKER_FRAME_LENGTH_BYTES, BROKER_MAX_FRAME_BYTES } from "./constants";
import { BrokerRpcError } from "./errors";

const jsonSchema = z.json();
const append = (
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> => {
  if (left.length === 0) return right.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
};

export const encodeBrokerFrame = (value: unknown): Uint8Array => {
  const json = jsonSchema.parse(value);
  const body = new TextEncoder().encode(JSON.stringify(json));
  if (body.length === 0 || body.length > BROKER_MAX_FRAME_BYTES) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      `Chrome broker frame must contain 1 through ${BROKER_MAX_FRAME_BYTES} bytes`,
    );
  }
  const frame = new Uint8Array(BROKER_FRAME_LENGTH_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, BROKER_FRAME_LENGTH_BYTES);
  return frame;
};

export type BrokerFrameDecoder = Readonly<{
  push: (chunk: Uint8Array) => unknown[];
}>;

export const createBrokerFrameDecoder = (): BrokerFrameDecoder => {
  let buffer = new Uint8Array<ArrayBufferLike>(new ArrayBuffer(0));
  return {
    push: (chunk) => {
      buffer = append(buffer, chunk);
      const values: unknown[] = [];
      while (buffer.length >= BROKER_FRAME_LENGTH_BYTES) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, BROKER_FRAME_LENGTH_BYTES).getUint32(
          0,
          false,
        );
        if (length === 0 || length > BROKER_MAX_FRAME_BYTES) {
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            `Chrome broker frame declared an invalid ${length}-byte body`,
          );
        }
        if (buffer.length < BROKER_FRAME_LENGTH_BYTES + length) break;
        const body = buffer.slice(BROKER_FRAME_LENGTH_BYTES, BROKER_FRAME_LENGTH_BYTES + length);
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(body));
        } catch (error: unknown) {
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            "Chrome broker frame contains invalid JSON",
            {
              cause: error,
            },
          );
        }
        values.push(jsonSchema.parse(parsed));
        buffer = buffer.slice(BROKER_FRAME_LENGTH_BYTES + length);
      }
      return values;
    },
  };
};

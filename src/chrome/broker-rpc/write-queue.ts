import { BROKER_MAX_QUEUED_WRITE_BYTES } from "./constants";

type BrokerWriteTarget = Readonly<{
  write: (data: Uint8Array) => number;
}>;

export type BrokerWriteQueue = Readonly<{
  close: () => void;
  flush: () => void;
  send: (frame: Uint8Array) => boolean;
}>;

export const createBrokerWriteQueue = (
  target: BrokerWriteTarget,
  onOverflow: () => void,
): BrokerWriteQueue => {
  const queue: Uint8Array[] = [];
  let closed = false;
  let offset = 0;
  let queuedBytes = 0;

  const clear = (): void => {
    queue.length = 0;
    offset = 0;
    queuedBytes = 0;
  };

  const flush = (): void => {
    while (queue.length > 0) {
      const frame = queue[0];
      if (!frame) return;
      const remaining = frame.subarray(offset);
      const written = Math.min(Math.max(target.write(remaining), 0), remaining.byteLength);
      if (written === 0) return;
      offset += written;
      queuedBytes -= written;
      if (offset < frame.length) return;
      queue.shift();
      offset = 0;
    }
  };

  return Object.freeze({
    close: () => {
      if (closed) return;
      closed = true;
      clear();
    },
    flush,
    send: (frame) => {
      if (closed) return false;
      if (queuedBytes + frame.byteLength > BROKER_MAX_QUEUED_WRITE_BYTES) {
        closed = true;
        clear();
        onOverflow();
        return false;
      }
      queue.push(frame);
      queuedBytes += frame.byteLength;
      flush();
      return true;
    },
  });
};

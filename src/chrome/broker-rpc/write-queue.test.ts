import { describe, expect, test } from "bun:test";
import { REACT_PROFILE_MAX_BYTES } from "../runtime/react-inspection-protocol";
import {
  BROKER_FRAME_LENGTH_BYTES,
  BROKER_MAX_FRAME_BYTES,
  BROKER_MAX_QUEUED_WRITE_BYTES,
} from "./constants";
import { createBrokerWriteQueue } from "./write-queue";

const createStalledSocket = () => {
  let ended = 0;
  let terminated = 0;
  let writable = false;
  let writes = 0;

  return {
    endCount: () => ended,
    setWritable: () => {
      writable = true;
    },
    socket: {
      end: () => {
        ended += 1;
      },
      terminate: () => {
        terminated += 1;
      },
      write: (data: Uint8Array) => {
        writes += 1;
        return writable ? data.byteLength : 0;
      },
    },
    terminateCount: () => terminated,
    writeCount: () => writes,
  };
};

describe("Chrome broker shared write queue", () => {
  test("flushes partial writes in frame order", () => {
    const output: number[] = [];
    const writes = createBrokerWriteQueue(
      {
        write: (data) => {
          const accepted = data.subarray(0, 3);
          output.push(...accepted);
          return accepted.byteLength;
        },
      },
      () => undefined,
    );

    writes.send(Uint8Array.from([1, 2, 3, 4, 5]));
    writes.send(Uint8Array.from([6, 7, 8]));
    writes.flush();

    expect(output).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("terminates a peer when stalled writes exceed one maximum React profile response", () => {
    expect(BROKER_MAX_QUEUED_WRITE_BYTES).toBe(
      REACT_PROFILE_MAX_BYTES + BROKER_FRAME_LENGTH_BYTES + BROKER_MAX_FRAME_BYTES,
    );
    const fake = createStalledSocket();
    const writes = createBrokerWriteQueue({ write: (data) => fake.socket.write(data) }, () =>
      fake.socket.terminate(),
    );

    const maximumFrame = new Uint8Array(BROKER_FRAME_LENGTH_BYTES + BROKER_MAX_FRAME_BYTES);
    const fullFrames = Math.floor(BROKER_MAX_QUEUED_WRITE_BYTES / maximumFrame.byteLength);
    for (let index = 0; index < fullFrames; index += 1) expect(writes.send(maximumFrame)).toBe(true);
    const remainder = BROKER_MAX_QUEUED_WRITE_BYTES % maximumFrame.byteLength;
    if (remainder > 0) expect(writes.send(new Uint8Array(remainder))).toBe(true);
    expect(writes.send(new Uint8Array(1))).toBe(false);
    expect(fake.terminateCount()).toBe(1);
  });

  test("close drops queued frames before a later drain", () => {
    const fake = createStalledSocket();
    const writes = createBrokerWriteQueue({ write: (data) => fake.socket.write(data) }, () =>
      fake.socket.terminate(),
    );
    writes.send(new Uint8Array(16));
    const attemptsBeforeClose = fake.writeCount();

    writes.close();
    fake.setWritable();
    writes.flush();

    expect(fake.writeCount()).toBe(attemptsBeforeClose);
  });
});

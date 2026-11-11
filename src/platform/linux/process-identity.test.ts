import { expect, test } from "bun:test";
import { parseLinuxProcessStat } from "./process-identity";

const statFields = (state: string) =>
  `${state} 11 42 42 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 987654 1000 200`;

test("reads the Linux process parent and start time after a command name containing spaces and parentheses", () => {
  expect(parseLinuxProcessStat(`42 (tmux: server (1) x) ${statFields("S")}`, 42)).toEqual({
    isZombie: false,
    pid: 42,
    ppid: 11,
    processStartIdentity: "linux:987654",
  });
});

test("reports a Linux zombie process", () => {
  expect(parseLinuxProcessStat(`42 (bun) ${statFields("Z")}`, 42)?.isZombie).toBe(true);
});

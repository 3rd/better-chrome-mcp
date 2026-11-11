import { inspect } from "node:util";

const writeConsoleValuesToStderr = (...values: unknown[]) => {
  process.stderr.write(
    `${values.map((value) => (typeof value === "string" ? value : inspect(value))).join(" ")}\n`,
  );
};

// A diagnostics worker answers its parent with one JSON document on stdout, so console output that reached
// stdout would make that document unparseable.
export const redirectConsoleToStderr = () => {
  console.debug = writeConsoleValuesToStderr;
  console.info = writeConsoleValuesToStderr;
  console.log = writeConsoleValuesToStderr;
};

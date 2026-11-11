import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { buildChromeFrontendBundles } from "../src/chrome/diagnostics/frontend-adapter";

const projectRoot = resolve(import.meta.dir, "..");
const outputDirectory = join(projectRoot, "dist");

const copyBundledLicenses = async (inputPaths: string[]) => {
  const directories = new Set<string>();

  for (const inputPath of inputPaths) {
    const absolutePath = resolve(projectRoot, inputPath);
    const packageMatch = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//u.exec(absolutePath);
    const packageDirectory = packageMatch?.[1];
    if (!packageDirectory) continue;

    let directory = dirname(absolutePath);

    while (directory.startsWith(packageDirectory)) {
      directories.add(directory);

      if (directory === packageDirectory) {
        break;
      }

      directory = dirname(directory);
    }
  }

  const licensePaths: string[] = [];

  for (const directory of [...directories].sort()) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const isLicense = entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:$|[._-])/iu.test(entry.name);
      if (!isLicense) continue;

      const source = join(directory, entry.name);
      const destination = join(
        outputDirectory,
        "licenses",
        relative(join(projectRoot, "node_modules"), source),
      );
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
      licensePaths.push(relative(outputDirectory, destination));
    }
  }

  await cp(
    join(projectRoot, "node_modules/lighthouse/LICENSE"),
    join(outputDirectory, "licenses/Apache-2.0.txt"),
  );
  licensePaths.push("licenses/Apache-2.0.txt");
  await writeFile(join(outputDirectory, "licenses/index.txt"), `${licensePaths.sort().join("\n")}\n`);
};

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(join(projectRoot, "src"), outputDirectory, {
  recursive: true,
  filter: (path) => {
    const name = basename(path);
    return (
      !name.includes(".test") &&
      !name.includes(".acceptance.") &&
      name !== "test-preload.ts" &&
      name !== "fixtures" &&
      name !== "test-fixtures" &&
      name !== "CLAUDE.md"
    );
  },
});

const vendorDirectory = join(outputDirectory, "vendor");
await mkdir(vendorDirectory, { recursive: true });
const result = await Bun.build({
  entrypoints: [Bun.resolveSync("fastmcp", projectRoot)],
  external: [
    "@modelcontextprotocol/sdk",
    "zod",
    "ajv",
    "ajv-formats",
    "jose",
    "@valibot/to-json-schema",
    "arktype",
    "effect",
    "sury",
  ],
  format: "esm",
  target: "bun",
  minify: false,
  metafile: true,
});
if (!result.success) {
  throw new AggregateError(result.logs, "Unable to build the patched MCP transport");
}

const output = result.outputs[0];
if (!output) {
  throw new Error("The MCP transport build produced no output");
}
if (!result.metafile) {
  throw new Error("The MCP transport build produced no input metadata");
}

await Bun.write(join(vendorDirectory, "fastmcp.js"), output);
await writeFile(
  join(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      type: "module",
      imports: { "#fastmcp": "./vendor/fastmcp.js" },
    },
    null,
    2,
  )}\n`,
);
const frontendInputs = await buildChromeFrontendBundles(join(outputDirectory, "chrome", "diagnostics"));
await copyBundledLicenses([...Object.keys(result.metafile.inputs), ...frontendInputs]);
await chmod(join(outputDirectory, "index.ts"), 0o755);

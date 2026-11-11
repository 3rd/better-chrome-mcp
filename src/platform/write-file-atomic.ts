import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type WriteFileAtomicOptions = {
  mode?: number;
};

export const writeFileAtomic = async (
  path: string,
  content: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
) => {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: options.mode });

    if (options.mode !== undefined) {
      await chmod(temporary, options.mode);
    }

    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

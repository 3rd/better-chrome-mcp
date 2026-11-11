export const MINIMUM_BUN_VERSION = [1, 4, 0] as const;
export const MINIMUM_BUN_VERSION_TEXT = MINIMUM_BUN_VERSION.join(".");

export const parseBunVersion = (value: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) return undefined;

  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

export const isSupportedBunVersion = (value: string) => {
  const currentVersion = parseBunVersion(value);
  if (!currentVersion) return false;

  for (const [index, element] of MINIMUM_BUN_VERSION.entries()) {
    const current = currentVersion[index] ?? 0;
    const minimum = element ?? 0;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
};

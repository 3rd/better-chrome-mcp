export const WINDOWS_SYSTEM_ENVIRONMENT_KEYS = [
  "APPDATA",
  "COMPUTERNAME",
  "ComSpec",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SystemDrive",
  "SystemRoot",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "windir",
] as const;

export const windowsSystemEnvironment = (source: NodeJS.ProcessEnv = process.env) => {
  const environment: Record<string, string> = {};

  if (process.platform !== "win32") return environment;

  for (const key of WINDOWS_SYSTEM_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value !== "string") continue;

    environment[key] = value;
  }

  return environment;
};

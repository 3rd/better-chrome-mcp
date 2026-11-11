export const isNodeError = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

import { ClientRequest } from "node:http";

const removeRelativeClientResponseUrl = (response: unknown): void => {
  if (typeof response !== "object" || response === null) return;
  const responseUrl: unknown = Object.getOwnPropertyDescriptor(response, "url")?.value;
  if (typeof responseUrl !== "string" || URL.canParse(responseUrl)) return;

  // Bun adds a relative URL to client responses, while Node leaves it undefined.
  // Playwright treats a present response URL as absolute when it parses Set-Cookie.
  Reflect.deleteProperty(response, "url");
};

export const installBunClientResponseUrlNormalization = (): void => {
  const emit = ClientRequest.prototype.emit;
  ClientRequest.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === "response") removeRelativeClientResponseUrl(args[0]);
    return Reflect.apply(emit, this, [event, ...args]);
  };
};

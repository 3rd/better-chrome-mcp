/** Hides the userinfo and the query of a CDP endpoint URL, which may carry credentials, before it is shown. */
export const redactEndpointUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!url.pathname.startsWith("/")) return "<invalid endpoint URL>";
    const userinfo = url.username || url.password ? "***@" : "";
    const query = url.search ? "?***" : "";
    return `${url.protocol}//${userinfo}${url.host}${url.pathname}${query}`;
  } catch {
    return "<invalid endpoint URL>";
  }
};

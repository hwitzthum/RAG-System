// Legacy cookie name — used as fallback for reading existing sessions
export const SESSION_COOKIE_NAME = "rag_access_token";

export function getSessionCookieName(isProduction: boolean): string {
  return isProduction ? "__Host-rag_access_token" : "rag_access_token";
}

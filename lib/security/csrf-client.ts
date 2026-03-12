/** Read the CSRF token from the double-submit cookie (client-side only). */
export function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)(?:csrf_token|__Host-csrf)=([^;]*)/);
  return match?.[1] ?? "";
}

/** Convenience: returns a headers object with X-CSRF-Token if available. */
export function csrfHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "X-CSRF-Token": token } : {};
}

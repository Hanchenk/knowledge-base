export const MAX_UPLOAD_MB = 500;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let error = `请求失败 (${response.status})`;
    try {
      const result = await response.json();
      error = result.error || result.message || error;
    } catch {
      /* Preserve HTTP status for non-JSON failures. */
    }
    if (response.status === 401 && path != "/api/auth/login")
      window.dispatchEvent(new Event("atlas:unauthorized"));
    throw new Error(error);
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export function date(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function bytes(value: number) {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

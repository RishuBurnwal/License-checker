import { ApiResponse } from "./types";

const TOKEN_KEY = "license_manager_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    // A kick-out (session_epoch bump) or a removed/expired token surfaces as a
    // 401: clear the stored token and send the operator back to the login screen
    // instead of leaving them stuck on a dead session.
    if (response.status === 401) {
      clearToken();
      if (typeof window !== "undefined" && window.location.pathname !== "/") {
        window.location.assign("/");
      } else if (typeof window !== "undefined") {
        window.location.reload();
      }
    }
    // A forced password change routes to the dedicated screen: reloading lets
    // App.tsx re-read /api/admin/me and render ForcedPasswordChange.
    if (payload.error.code === "PASSWORD_CHANGE_REQUIRED" && typeof window !== "undefined") {
      window.location.reload();
    }
    throw new Error(payload.error.message || payload.error.code);
  }
  return payload.data;
}

export function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

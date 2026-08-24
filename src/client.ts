/**
 * Minimal Venelx REST API client built on the global fetch (no dependencies).
 *
 * Configuration via environment:
 *   VENELX_API_URL  API base URL (default https://api.venelx.com)
 *   VENELX_TOKEN    Personal API token (vx_...), created at Account → API tokens
 */

const DEFAULT_API_URL = 'https://api.venelx.com';
const TOKEN_SETUP_URL = 'https://app.venelx.com/account/tokens';

export function apiUrl(): string {
  return (process.env.VENELX_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

export function requireToken(): string {
  const token = process.env.VENELX_TOKEN?.trim();
  if (!token) {
    throw new Error(
      `VENELX_TOKEN is not set. Create a personal API token at Account → API tokens (${TOKEN_SETUP_URL}) ` +
        'and pass it as the VENELX_TOKEN environment variable in your MCP server config.'
    );
  }
  return token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<unknown> {
  const method = options.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
    const code = cause?.code ? ` (${cause.code})` : '';
    throw new Error(
      `Could not reach the Venelx API at ${apiUrl()}${code}. ` +
        'Check VENELX_API_URL and your network connection.'
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const record = data as { error?: unknown; message?: unknown } | null;
    const serverMessage =
      (typeof record?.error === 'string' && record.error) ||
      (typeof record?.message === 'string' && record.message) ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, serverMessage);
  }
  return data;
}

export function get(path: string): Promise<unknown> {
  return apiFetch(path);
}

export function post(path: string, body?: unknown): Promise<unknown> {
  return apiFetch(path, { method: 'POST', body });
}

export function del(path: string): Promise<unknown> {
  return apiFetch(path, { method: 'DELETE' });
}

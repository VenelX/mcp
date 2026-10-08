/**
 * Minimal Venelx REST API client built on the global fetch (no dependencies).
 *
 * Configuration via environment:
 *   VENELX_API_URL  API base URL (default https://api.venelx.com)
 *   VENELX_TOKEN    Personal API token (vx_...), created at Account → API tokens
 *                   or via `venelx-mcp login` (saved to ~/.venelx/mcp-token,
 *                   used as a fallback when the env var isn't set).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_API_URL = 'https://api.venelx.com';
const TOKEN_SETUP_URL = 'https://app.venelx.com/account/tokens';
export const TOKEN_FILE = path.join(os.homedir(), '.venelx', 'mcp-token');

export function apiUrl(): string {
  return (process.env.VENELX_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

export function readSavedToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
}

export function requireToken(): string {
  const token = process.env.VENELX_TOKEN?.trim() || readSavedToken();
  if (!token) {
    throw new Error(
      `No Venelx token found. Run \`npx @venelx/mcp login\` to sign in, or create a personal API ` +
        `token at Account → API tokens (${TOKEN_SETUP_URL}) and pass it as the VENELX_TOKEN ` +
        'environment variable in your MCP server config.'
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
    const record = data as { error?: unknown; message?: unknown; details?: unknown } | null;
    let serverMessage =
      (typeof record?.error === 'string' && record.error) ||
      (typeof record?.message === 'string' && record.message) ||
      `HTTP ${res.status}`;
    // Validation endpoints (e.g. build commands) list each rejected item here.
    if (Array.isArray(record?.details) && record.details.length) {
      serverMessage += ` — ${record.details.map(String).join('; ')}`;
    }
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

export function put(path: string, body?: unknown): Promise<unknown> {
  return apiFetch(path, { method: 'PUT', body });
}

export function patch(path: string, body?: unknown): Promise<unknown> {
  return apiFetch(path, { method: 'PATCH', body });
}

export function del(path: string): Promise<unknown> {
  return apiFetch(path, { method: 'DELETE' });
}

export type MultipartFile = { filename: string; base64: string; contentType?: string };
export type MultipartFields = Record<string, string | MultipartFile>;

/** POST multipart/form-data — for file uploads (signing credentials, keystores). */
export async function postMultipart(path: string, fields: MultipartFields): Promise<unknown> {
  const form = new FormData();
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === 'string') {
      form.append(key, val);
    } else {
      const bytes = Buffer.from(val.base64, 'base64');
      form.append(key, new Blob([bytes], { type: val.contentType || 'application/octet-stream' }), val.filename);
    }
  }

  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireToken()}` },
      body: form,
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
    const code = cause?.code ? ` (${cause.code})` : '';
    throw new Error(`Could not reach the Venelx API at ${apiUrl()}${code}. Check VENELX_API_URL and your network connection.`);
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

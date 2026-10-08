import { getStoredTokens } from "./tokenStorage";
import { RefreshError, refreshTokens } from "./refresh";

export class ApiError extends Error {
  status: number;
  detail: string;
  /** The parsed JSON error body when there was one (e.g. a 422's `violations`), else null. */
  body: unknown;

  constructor(status: number, detail: string, body: unknown = null) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Set true when `body` is already a FormData instance (multipart upload). */
  isFormData?: boolean;
}

async function readError(response: Response): Promise<{ detail: string; body: unknown }> {
  try {
    const body = (await response.json()) as { detail?: string } | null;
    return { detail: body?.detail ?? response.statusText, body };
  } catch {
    return { detail: response.statusText, body: null };
  }
}

function buildHeaders(options: ApiRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  const tokens = getStoredTokens();
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  if (options.body !== undefined && !options.isFormData) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function buildBody(options: ApiRequestOptions): BodyInit | undefined {
  if (options.body === undefined) return undefined;
  return options.isFormData ? (options.body as FormData) : JSON.stringify(options.body);
}

async function doFetch(path: string, options: ApiRequestOptions): Promise<Response> {
  return fetch(path, {
    method: options.method ?? "GET",
    headers: buildHeaders(options),
    body: buildBody(options),
  });
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  let response = await doFetch(path, options);

  if (response.status === 401) {
    try {
      await refreshTokens();
    } catch (err) {
      if (err instanceof RefreshError) {
        throw new ApiError(401, "Session expired");
      }
      throw err;
    }
    response = await doFetch(path, options);
  }

  if (!response.ok) {
    const { detail, body } = await readError(response);
    throw new ApiError(response.status, detail, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

import { getStoredTokens } from "./tokenStorage";
import { RefreshError, refreshTokens } from "./refresh";

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Set true when `body` is already a FormData instance (multipart upload). */
  isFormData?: boolean;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    return body.detail ?? response.statusText;
  } catch {
    return response.statusText;
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
    throw new ApiError(response.status, await readErrorDetail(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

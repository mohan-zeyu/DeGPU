// Talking to the local DeGPU app (docs/API.md). Every POST carries X-DeGPU: 1, and errors
// arrive as {"detail": "..."}, a sentence that can be shown as is.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Network state the whole GUI reacts to: "locked" (423), "offline" (503) or back "online". */
export type NetSignal = "locked" | "offline" | "online";
let offline = false;

function signal(kind: NetSignal) {
  window.dispatchEvent(new CustomEvent<NetSignal>("degpu:net", { detail: kind }));
}

function note(status: number) {
  if (status === 423) signal("locked");
  if (status === 503 && !offline) {
    offline = true;
    signal("offline");
  } else if (status !== 503 && offline) {
    offline = false;
    signal("online");
  }
}

const NOT_RUNNING = "The DeGPU app isn't running on this computer. Start it with: uv run degpu app";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-DeGPU", "1");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, NOT_RUNNING);
  }
  note(r.status);
  if (!r.ok) {
    const body = await r.json().catch(() => ({ detail: r.statusText }));
    throw new ApiError(r.status, String(body.detail ?? r.statusText));
  }
  return r.json() as Promise<T>;
}

export const get = <T>(path: string) => api<T>(path);

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/** POST a form with files, reporting upload progress (0..1). fetch can't report it, XHR can. */
export function postForm<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("X-DeGPU", "1");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      note(xhr.status);
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else reject(new ApiError(xhr.status, String(xhr.response?.detail ?? xhr.statusText)));
    };
    xhr.onerror = () => reject(new ApiError(0, NOT_RUNNING));
    xhr.send(form);
  });
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

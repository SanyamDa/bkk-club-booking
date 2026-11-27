export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; message?: string; issues?: { field?: string; message: string }[] },
  ) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const STATUS_LABEL: Record<string, string> = {
  held: 'Held',
  awaiting_payment: 'Awaiting deposit',
  payment_review: 'Check slip',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired',
  abandoned: 'Abandoned',
  rejected: 'Rejected',
};

export function Status({ status }: { status: string }) {
  return <span className={`chip s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

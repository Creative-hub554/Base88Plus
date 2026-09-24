/**
 * Query an OpenAI-compatible /models endpoint. Accepts the canonical
 * `{ data: [{ id }] }` shape, bare arrays, and Cloudflare's envelope
 * (`{ result: { data: [...] } }` — Workers AI). Returns [] on non-OK —
 * catalog listing is best-effort and must never throw beyond the fetch.
 */
export async function fetchModels(
  baseURL: string,
  apiKey?: string,
): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { id?: string }[];
    result?: { data?: { id?: string }[] };
  } | { id?: string }[];
  const list = Array.isArray(json)
    ? json
    : (json.data ?? ("result" in json ? json.result?.data : undefined) ?? []);
  return list
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .sort();
}

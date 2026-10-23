namespace Api {
  export async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json"))
      throw new Error(`Expected JSON from ${url} (HTTP ${response.status}). Reload the dashboard and try again.`);
    const data = await response.json();
    if (!response.ok)
      throw new Error(typeof data?.error === "string" ? data.error : `Request failed (HTTP ${response.status}).`);
    return data;
  }

  export function save(url: string, body: unknown): Promise<unknown> {
    return json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

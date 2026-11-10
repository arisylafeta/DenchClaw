/** Small pieces every Relay screen uses. */

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

const PALETTE = ["#2563EB", "#0EA5E9", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0D9488", "#4F46E5", "#B45309"];
/** A person's avatar colour: the same on every screen. */
export const colour = (name: string) => PALETTE[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
export const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
export const firstName = (name: string | null | undefined) => (name ?? "").split(/[\s@]/)[0] || "them";

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, { method: init?.method ?? "GET", headers: init?.body ? { "content-type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined, cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? "Something went wrong. Try again.");
  return data as T;
}

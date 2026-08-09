import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { queryPg } from "@/lib/postgres";
const scrypt = promisify(nodeScrypt);
export const ALLOWED_EMAILS = new Set([
  "ari@rebattery.io",
  "alex@rebattery.io",
]);
export const SESSION_COOKIE = "denchclaw_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [, salt, hex] = encoded.split("$");
  if (!salt || !hex) return false;
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return expected.length === key.length && timingSafeEqual(key, expected);
}
export async function login(
  email: string,
  password: string,
): Promise<{ id: string; email: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!ALLOWED_EMAILS.has(normalized)) return null;
  const rows = await queryPg<{
    id: string;
    email: string;
    password_hash: string;
    is_active: boolean;
    failed_login_count: number;
    locked_until: string | null;
  }>(`select * from crm_users where email=$1`, [normalized]);
  const user = rows[0];
  if (
    !user ||
    !user.is_active ||
    (user.locked_until && Date.parse(user.locked_until) > Date.now())
  )
    return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const count = user.failed_login_count + 1;
    await queryPg(
      `update crm_users set failed_login_count=$2, locked_until=case when $2 >= 10 then now()+interval '15 minutes' else locked_until end where id=$1`,
      [user.id, count],
    );
    return null;
  }
  await queryPg(
    `update crm_users set failed_login_count=0,locked_until=null,last_login_at=now() where id=$1`,
    [user.id],
  );
  return { id: user.id, email: user.email };
}
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await queryPg(
    `insert into crm_sessions(user_id,token_hash,expires_at) values($1,$2,$3)`,
    [userId, hashToken(token), new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}
export async function validateSessionToken(token: string) {
  if (!token || token.length < 40) return null;
  const rows = await queryPg<{ id: string; email: string }>(
    `select u.id,u.email from crm_sessions s join crm_users u on u.id=s.user_id where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and u.is_active`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}
export async function currentUser() {
  const c = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!c) return null;
  const rows = await queryPg<{ id: string; email: string }>(
    `select u.id,u.email from crm_sessions s join crm_users u on u.id=s.user_id where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and u.is_active`,
    [hashToken(c)],
  );
  if (!rows[0]) return null;
  await queryPg(
    `update crm_sessions set last_seen_at=now() where token_hash=$1`,
    [hashToken(c)],
  );
  return rows[0];
}
export async function revokeSession() {
  const c = (await cookies()).get(SESSION_COOKIE)?.value;
  if (c)
    await queryPg(
      `update crm_sessions set revoked_at=now() where token_hash=$1`,
      [hashToken(c)],
    );
}
export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

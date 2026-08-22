import {
  createHash,
  randomBytes,
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
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 1024;

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | null;
};

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, salt, hex] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !hex || !/^[0-9a-f]{128}$/i.test(hex))
    return false;
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return timingSafeEqual(key, expected);
}

export async function login(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const normalized = email.trim().toLowerCase();
  if (
    !ALLOWED_EMAILS.has(normalized) ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return null;
  }

  const rows = await queryPg<UserRow>(
    `select id, email, display_name, password_hash, is_active, failed_login_count, locked_until
       from crm_users
      where email = $1`,
    [normalized],
  );
  const user = rows[0];
  if (
    !user ||
    !user.is_active ||
    (user.locked_until && Date.parse(user.locked_until) > Date.now())
  ) {
    return null;
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    await queryPg(
      `update crm_users
          set failed_login_count = failed_login_count + 1,
              locked_until = case
                when failed_login_count + 1 >= 10 then now() + interval '15 minutes'
                else locked_until
              end,
              updated_at = now()
        where id = $1`,
      [user.id],
    );
    return null;
  }

  await queryPg(
    `update crm_users
        set failed_login_count = 0,
            locked_until = null,
            last_login_at = now(),
            updated_at = now()
      where id = $1`,
    [user.id],
  );
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await queryPg(
    `insert into crm_sessions(user_id, token_hash, expires_at) values($1, $2, $3)`,
    [userId, hashToken(token), new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}

export async function validateSessionToken(
  token: string,
): Promise<AuthenticatedUser | null> {
  if (!token || token.length < 40 || token.length > 128) return null;
  const rows = await queryPg<{
    id: string;
    email: string;
    display_name: string;
  }>(
    `select u.id, u.email, u.display_name
       from crm_sessions s
       join crm_users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.is_active`,
    [hashToken(token)],
  );
  const user = rows[0];
  return user
    ? { id: user.id, email: user.email, displayName: user.display_name }
    : null;
}

export async function refreshSessionToken(
  token: string,
): Promise<AuthenticatedUser | null> {
  if (!token || token.length < 40 || token.length > 128) return null;
  const rows = await queryPg<{
    id: string;
    email: string;
    display_name: string;
  }>(
    `update crm_sessions s
        set expires_at = $2,
            last_seen_at = now()
       from crm_users u
      where s.token_hash = $1
        and s.user_id = u.id
        and s.revoked_at is null
        and s.expires_at > now()
        and u.is_active
      returning u.id, u.email, u.display_name`,
    [hashToken(token), new Date(Date.now() + SESSION_TTL_MS)],
  );
  const user = rows[0];
  return user
    ? { id: user.id, email: user.email, displayName: user.display_name }
    : null;
}

export async function currentUser(): Promise<AuthenticatedUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await validateSessionToken(token);
  if (!user) return null;
  await queryPg(
    `update crm_sessions set last_seen_at = now() where token_hash = $1`,
    [hashToken(token)],
  );
  return user;
}

export async function revokeSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  await queryPg(
    `update crm_sessions set revoked_at = now() where token_hash = $1`,
    [hashToken(token)],
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

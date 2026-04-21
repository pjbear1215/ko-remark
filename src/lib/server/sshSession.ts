import type { NextRequest } from "next/server";

export interface SshCredentials {
  ip: string;
  password: string;
}

interface SshSession extends SshCredentials {
  expiresAt: number;
}

export const SSH_SESSION_COOKIE = "rekoit-ssh";
const SSH_SESSION_TTL_MS = 5 * 60 * 1000;

export function shouldUseSecureSessionCookie(hostname: string): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

export function createSshSession(ip: string, password: string): string {
  if (!/^[0-9.]+$/.test(ip)) {
    throw new Error("Invalid IP address format");
  }

  const payload: SshSession = {
    ip,
    password,
    expiresAt: Date.now() + SSH_SESSION_TTL_MS,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function getSshSession(token: string): SshCredentials | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as Partial<SshSession>;

    if (
      typeof payload.ip !== "string" ||
      typeof payload.password !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }

    if (payload.expiresAt <= Date.now()) {
      return null;
    }

    return { ip: payload.ip, password: payload.password };
  } catch {
    return null;
  }
}

export function getSshSessionFromRequest(
  request: NextRequest,
): SshCredentials | null {
  const token = request.cookies.get(SSH_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  return getSshSession(token);
}

export function getSshSessionCookieConfig(token: string, hostname: string) {
  return {
    name: SSH_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure:
      process.env.NODE_ENV === "production" &&
      shouldUseSecureSessionCookie(hostname),
    path: "/",
    maxAge: Math.floor(SSH_SESSION_TTL_MS / 1000),
  };
}

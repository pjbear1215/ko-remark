import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";

function sshExec(
  ip: string,
  password: string,
  command: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SSHPASS: password,
      PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
    };
    const proc = spawn(
      "sshpass",
      [
        "-e",
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=30",
        `root@${ip}`,
        command,
      ],
      { env },
    );

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data));

    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("timeout"));
    }, 120000);
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const session = getSshSessionFromRequest(request);
  if (!session) {
    return new Response("Missing SSH session", { status: 401 });
  }

  try {
    const tarData = await sshExec(
      session.ip,
      session.password,
      "tar czf - -C /home/root rekoit 2>/dev/null",
    );

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

    return new Response(new Uint8Array(tarData), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="rekoit-backup_${timestamp}.tar.gz"`,
        "Content-Length": String(tarData.length),
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

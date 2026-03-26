import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const address = searchParams.get("address") ?? "";
  const session = getSshSessionFromRequest(request);

  if (!session || !address) {
    return Response.json({ error: "Invalid parameters" }, { status: 400 });
  }

  if (!/^[0-9A-Fa-f:]+$/.test(address)) {
    return Response.json({ error: "Invalid BT address" }, { status: 400 });
  }

  const env = { ...process.env, SSHPASS: session.password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        "sshpass",
        [
          "-e",
          "ssh",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=10",
          `root@${session.ip}`,
          `bluetoothctl info ${address} 2>/dev/null || echo "NOT_FOUND"`,
        ],
        { env },
      );

      let output = "";
      proc.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      proc.stderr.on("data", () => {});

      proc.on("close", () => resolve(output));
      setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, 15000);
    });

    const paired = result.includes("Paired: yes");
    const connected = result.includes("Connected: yes");
    const trusted = result.includes("Trusted: yes");

    return Response.json({ paired, connected, trusted, ready: paired && trusted && connected });
  } catch {
    return Response.json({ error: "확인 실패" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function runScp(
  ip: string,
  password: string,
  localPath: string,
  remotePath: string,
): Promise<string> {
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
        "scp",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        localPath,
        `root@${ip}:${remotePath}`,
      ],
      { env },
    );

    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve("OK");
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("timeout"));
    }, 120000);
  });
}

function runSsh(
  ip: string,
  password: string,
  command: string,
): Promise<string> {
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

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("timeout"));
    }, 120000);
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const file = formData.get("backup") as File | null;
  const ip = formData.get("ip") as string | null;
  const password = formData.get("password") as string | null;

  if (!file || !ip || !password) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  if (!/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "Invalid IP" }, { status: 400 });
  }

  if (!file.name.endsWith(".tar.gz") && !file.name.endsWith(".tgz")) {
    return NextResponse.json(
      { error: "tar.gz 파일만 지원합니다" },
      { status: 400 },
    );
  }

  const tmpDir = path.join(os.tmpdir(), "rekoit-restore");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "backup.tar.gz");

  try {
    // Save uploaded file
    const arrayBuffer = await file.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(arrayBuffer));

    // Upload tar.gz to device
    await runScp(ip, password, tmpFile, "/tmp/hangul-backup.tar.gz");

    // Extract on device and run install
    const output = await runSsh(
      ip,
      password,
      [
        "mount -o remount,rw / 2>/dev/null || true",
        "rm -rf /home/root/rekoit",
        "tar xzf /tmp/hangul-backup.tar.gz -C /home/root",
        "rm -f /tmp/hangul-backup.tar.gz",
        // Re-apply current install state
        "if [ -x /home/root/rekoit/install.sh ]; then " +
          "bash /home/root/rekoit/install.sh 2>&1; " +
        "else " +
          "echo 'install.sh not found, applying files manually...' && " +
          // Font
          "if [ -f /home/root/rekoit/fonts/NotoSansCJKkr-Regular.otf ]; then " +
            "mkdir -p /usr/share/fonts/ttf/noto && " +
            "cp /home/root/rekoit/fonts/NotoSansCJKkr-Regular.otf /usr/share/fonts/ttf/noto/ && " +
            "fc-cache -f 2>/dev/null || true && " +
            "echo 'OK: font restored'; " +
          "fi && " +
          // Restore service
          "if [ -f /home/root/rekoit/restore.sh ]; then " +
            "chmod +x /home/root/rekoit/restore.sh && " +
            "bash /home/root/rekoit/restore.sh 2>&1; " +
          "fi && " +
          "systemctl daemon-reload && " +
          "systemctl restart xochitl 2>/dev/null || true; " +
        "fi",
      ].join(" && "),
    );

    return NextResponse.json({
      success: true,
      message: "백업에서 복원 완료",
      output,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

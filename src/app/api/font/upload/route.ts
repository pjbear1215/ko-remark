import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

function runScp(
  ip: string,
  password: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
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
      if (code === 0) resolve();
      else {
        const errorLines = stderr
          .split("\n")
          .filter((l) => !l.includes("Warning: Permanently added") && l.trim())
          .join("\n");
        reject(new Error(errorLines || `SCP failed with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

function runSsh(ip: string, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
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
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get("font") as File | null;
  const ip = formData.get("ip") as string | null;
  const password = formData.get("password") as string | null;

  if (!file || !ip || !password) {
    return Response.json({ error: "Missing parameters" }, { status: 400 });
  }

  if (!/^[\d.]+$/.test(ip)) {
    return Response.json({ error: "Invalid IP" }, { status: 400 });
  }

  // 폰트 파일 확장자 확인
  const ext = file.name.toLowerCase().split(".").pop();
  if (!ext || !["otf", "ttf", "woff2"].includes(ext)) {
    return Response.json({ error: "지원되지 않는 폰트 형식입니다. OTF, TTF만 가능합니다." }, { status: 400 });
  }

  // 크기 확인 (50MB 제한)
  if (file.size > 50 * 1024 * 1024) {
    return Response.json({ error: "폰트 파일이 너무 큽니다. (최대 50MB)" }, { status: 400 });
  }

  try {
    // 임시 파일로 저장
    const tmpDir = path.join(process.cwd(), "resources", ".tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `font_upload.${ext}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);

    // 리마커블에 업로드
    await runScp(ip, password, tmpPath, "/home/root/rekoit/fonts/NotoSansCJKkr-Regular.otf");

    // 시스템 폰트 경로에도 복사 + xochitl 재시작
    await runSsh(ip, password, `
      mount -o remount,rw / 2>/dev/null || true
      mkdir -p /usr/share/fonts/ttf/noto
      cp /home/root/rekoit/fonts/NotoSansCJKkr-Regular.otf /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
      fc-cache -f 2>/dev/null || true
      systemctl restart xochitl 2>/dev/null || true
    `);

    // 로컬 resources에도 저장 (다음 설치 시 사용)
    const localFontPath = path.join(process.cwd(), "resources", "fonts", "NotoSansCJKkr-Regular.otf");
    fs.mkdirSync(path.dirname(localFontPath), { recursive: true });
    fs.copyFileSync(tmpPath, localFontPath);

    // 임시 파일 제거
    fs.unlinkSync(tmpPath);

    return Response.json({ success: true, message: "폰트가 교체되었습니다. xochitl이 재시작됩니다." });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: msg }, { status: 500 });
  }
}

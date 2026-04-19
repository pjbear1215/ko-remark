import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface SshTestRequest {
  ip: string;
  password: string;
}

function buildSshCommand(ip: string, command: string): string {
  const escapedCommand = command.replace(/'/g, "'\\''");
  // Force ONLY password authentication and prevent any interactive prompts or key fallback
  const sshOpts = [
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o ConnectTimeout=10",
    "-o PubkeyAuthentication=no",
    "-o PasswordAuthentication=yes",
    "-o PreferredAuthentications=password",
    "-o NumberOfPasswordPrompts=1",
  ].join(" ");
  return `sshpass -e ssh ${sshOpts} root@${ip} '${escapedCommand}'`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as SshTestRequest;
  const { ip, password } = body;

  if (!ip || !password) {
    return NextResponse.json(
      { error: "IP와 비밀번호가 필요합니다." },
      { status: 400 },
    );
  }

  // Validate IP format
  if (!/^[\d.]+$/.test(ip)) {
    return NextResponse.json(
      { error: "잘못된 IP 주소 형식입니다." },
      { status: 400 },
    );
  }

  try {
    const sshCmd = buildSshCommand(
      ip,
      "hostname; cat /etc/version 2>/dev/null || echo unknown; df -h /home | tail -1 | awk '{print $4}'; cat /proc/device-tree/model 2>/dev/null || echo unknown",
    );
    const extPath = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
    // Pass SSHPASS securely through the env object
    const { stdout } = await execAsync(sshCmd, { 
      timeout: 15000, 
      env: { 
        ...process.env, 
        PATH: extPath,
        SSHPASS: password 
      } 
    });
    const lines = stdout.trim().split("\n");

    const model = (lines[3] ?? "unknown").replace(/\0/g, "").trim();

    // 기기 모델 자동 감지 (코드네임 기반)
    // Paper Pro = "Ferrari" (i.MX8MM)
    // Paper Pro Move = "Chiappa" (i.MX93)
    // reMarkable 2 등 기타 기기는 미지원
    const modelLower = model.toLowerCase();
    let detectedDevice: "paper-pro-move" | "paper-pro" | null = null;
    if (modelLower.includes("ferrari")) {
      detectedDevice = "paper-pro";
    } else if (modelLower.includes("chiappa")) {
      detectedDevice = "paper-pro-move";
    }

    return NextResponse.json({
      connected: true,
      reachable: true,
      hostname: (lines[0] ?? "unknown").trim(),
      firmware: (lines[1] ?? "unknown").trim(),
      freeSpace: (lines[2] ?? "unknown").trim(),
      model,
      detectedDevice,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    let diagnosis = "연결에 실패했습니다.";
    let status = 400;

    if (msg.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
      diagnosis = "SSH 호스트 키가 변경되었습니다. known_hosts 파일을 확인하세요.";
    } else if (msg.includes("Permission denied")) {
      diagnosis = "SSH 비밀번호가 올바르지 않습니다. 기기 설정에서 정확한 비밀번호를 확인하세요.";
      status = 401;
    } else if (msg.includes("Connection refused")) {
      diagnosis = "SSH 서비스가 응답하지 않습니다. USB 연결을 확인하세요.";
    } else if (msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
      diagnosis = "연결 시간이 초과되었습니다. USB 케이블을 확인하세요.";
    } else if (msg.includes("command not found")) {
      diagnosis = "sshpass가 설치되어 있지 않습니다. 사전 준비 단계에서 설치하거나 호스트 터미널에서 직접 설치하세요.";
    }
    return NextResponse.json(
      { connected: false, reachable: false, error: diagnosis },
      { status },
    );
  }
}

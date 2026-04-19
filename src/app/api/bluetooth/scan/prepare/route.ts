import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";

export async function POST(request: NextRequest): Promise<Response> {
  const session = getSshSessionFromRequest(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const env = { ...process.env, SSHPASS: session.password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
  
  // 하드웨어 준비만 수행하고 세션을 종료함 (정리 스크립트 실행 안 함)
  const prepCmd = `
    # 1. 재연결 서비스 중단 및 센티넬 생성
    systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
    killall -9 bluetoothctl 2>/dev/null || true
    touch /tmp/rekoit-setup-active
    touch /tmp/ko-remark-pair-SCAN.sh
    
    # 2. 하드웨어 리셋
    modprobe btnxpuart 2>/dev/null || true
    systemctl restart bluetooth.service 2>/dev/null || true
    sleep 3.5
    
    # 3. 어댑터 활성화
    bluetoothctl power on 2>/dev/null || true
    bluetoothctl pairable on 2>/dev/null || true
    
    # 활성화 확인 루프
    COUNT=0
    while [ $COUNT -lt 10 ]; do
      if bluetoothctl show | grep -q "Powered: yes"; then break; fi
      sleep 1
      COUNT=$((COUNT+1))
    done
    
    # 4. 필터 설정 (LE 전용)
    bluetoothctl discovery-filter --clear 2>/dev/null || true
    bluetoothctl discovery-filter --transport le 2>/dev/null || true
  `;

  return new Promise((resolve) => {
    const proc = spawn("sshpass", ["-e", "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", `root@${session.ip}`, prepCmd], { env });
    proc.on("close", (code) => {
      resolve(new Response(JSON.stringify({ success: code === 0 }), { status: 200 }));
    });
  });
}

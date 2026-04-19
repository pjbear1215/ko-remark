import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import {
  buildBluetoothKeyboardCleanupScript,
  buildKeyboardBluetoothAddressScanScript,
} from "@/lib/bluetoothCleanup.js";
import {
  buildFontRemovalCommands,
  HANGUL_FONT_PATH,
} from "@/lib/uninstallFontBehavior.js";

function runSshOnce(
  ip: string,
  password: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
    const proc = spawn(
      "sshpass",
      [
        "-e",
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
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
      // SSH 경고 메시지 필터링 (정상 동작)
      const filteredStderr = stderr
        .split("\n")
        .filter((line) => !line.includes("Warning: Permanently added") && !line.includes("Connection to") && line.trim() !== "")
        .join("\n")
        .trim();
      if (code === 0) resolve(stdout);
      else reject(new Error(filteredStderr || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function runSsh(
  ip: string,
  password: string,
  command: string,
  retries = 3,
): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      return await runSshOnce(ip, password, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1 && msg.includes("Permission denied")) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("SSH connection failed after retries");
}

interface DetectionResult {
  hangulInstalled: boolean;
  btInstalled: boolean;
  hasInstallStateFile: boolean;
  hasKeyboardPairings: boolean;
  hasLibepaperBackup: boolean;
  hasFactoryGuard: boolean;
  hasSwupdateHook: boolean;
  hasFont: boolean;
}

async function detectInstallation(
  ip: string,
  password: string,
): Promise<DetectionResult> {
  const keyboardScanScript = buildKeyboardBluetoothAddressScanScript().trim();
  const output = await runSsh(
    ip,
    password,
    `echo "=== DETECT ==="
    if [ -f /home/root/rekoit/install-state.conf ]; then
      . /home/root/rekoit/install-state.conf
      echo "STATE_FILE=yes"
      echo "STATE_HANGUL=\${INSTALL_HANGUL:-}"
      echo "STATE_BT=\${INSTALL_BT:-0}"
    else
      echo "STATE_FILE=no"
      echo "STATE_HANGUL="
      echo "STATE_BT=0"
    fi

    # 일반 Hangul 설치 파일 존재 여부 (/dev/null mask 링크 제외)
    HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
    if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
      echo "HANGUL=yes"
    else
      echo "HANGUL=no"
    fi

    # BT 지원 여부
    if [ -f /etc/modules-load.d/btnxpuart.conf ]; then
      echo "BT=yes"
    else
      echo "BT=no"
    fi

    KEYBOARD_BT_COUNT=0
    for ADDR in $(
      ${keyboardScanScript}
    ); do
      KEYBOARD_BT_COUNT=$((KEYBOARD_BT_COUNT + 1))
    done
    [ "$KEYBOARD_BT_COUNT" -gt 0 ] && echo "KEYBOARD_BT=yes" || echo "KEYBOARD_BT=no"

    # libepaper 백업
    [ -f /home/root/rekoit/backup/libepaper.so.original ] && echo "LIBEPAPER_BACKUP=yes" || echo "LIBEPAPER_BACKUP=no"

    # factory-guard
    [ -f /opt/rekoit/factory-guard.sh ] && echo "FACTORY_GUARD=yes" || echo "FACTORY_GUARD=no"

    # swupdate conf.d hook
    [ -f /etc/swupdate/conf.d/99-rekoit-postupdate ] && echo "SWUPDATE_HOOK=yes" || echo "SWUPDATE_HOOK=no"

    # 한글 폰트
    [ -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf ] && echo "FONT=yes" || echo "FONT=no"`,
  );

  const get = (key: string): boolean => output.includes(`${key}=yes`);

  return {
    hangulInstalled: get("HANGUL"),
    btInstalled: get("BT"),
    hasInstallStateFile: output.includes("STATE_FILE=yes"),
    hasKeyboardPairings: get("KEYBOARD_BT"),
    hasLibepaperBackup: get("LIBEPAPER_BACKUP"),
    hasFactoryGuard: get("FACTORY_GUARD"),
    hasSwupdateHook: get("SWUPDATE_HOOK"),
    hasFont: get("FONT"),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const cleanupFiles = searchParams.get("cleanup") !== "false";
  const deleteFont = searchParams.get("deleteFont") !== "false";
  const session = getSshSessionFromRequest(request);

  if (!session) {
    return new Response("Missing SSH session", { status: 401 });
  }

  const { ip, password } = session;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const keyboardScanScript = buildKeyboardBluetoothAddressScanScript().trim();
        const storedBluetoothAddressScanScript = `
          {
            bluetoothctl devices 2>/dev/null || true
            bluetoothctl devices Paired 2>/dev/null || true
            bluetoothctl devices Trusted 2>/dev/null || true
            bluetoothctl devices Connected 2>/dev/null || true
          } | awk '/^Device [0-9A-F:]+/ {print $2}'
          find /var/lib/bluetooth -mindepth 2 -maxdepth 2 -type d 2>/dev/null | awk -F/ '
            /^[0-9A-F:]{17}$/ && $(NF-1) != "cache" {print $NF}
          '
        `.trim();
        // === Step 0: 설치 상태 감지 ===
        send("step", { step: 0, name: "설치 상태 감지", status: "running" });
        send("progress", { percent: 5, step: 0 });

        const detected = await detectInstallation(ip, password);

        // 감지 결과 전송
        send("detect", {
          hangul: detected.hangulInstalled,
          bt: detected.btInstalled,
          factoryGuard: detected.hasFactoryGuard,
          swupdateHook: detected.hasSwupdateHook,
          keyboardBt: detected.hasKeyboardPairings,
        });

        if (detected.hangulInstalled) {
          send("log", { line: "감지: 한글 입력 런타임 설치됨" });
        }
        if (detected.btInstalled) {
          send("log", { line: "감지: 블루투스 키보드 지원 설치됨" });
        }
        if (detected.hasKeyboardPairings) {
          send("log", { line: "감지: 블루투스 키보드 페어링 데이터가 남아있음" });
        }
        if (detected.hasFactoryGuard) {
          send("log", { line: "감지: 팩토리 리셋 안전장치 설치됨" });
        }
        if (detected.hasSwupdateHook) {
          send("log", { line: "감지: 펌웨어 업데이트 보호 설치됨" });
        }
        if (
          !detected.hangulInstalled
          && !detected.btInstalled
          && !detected.hasKeyboardPairings
          && !detected.hasInstallStateFile
          && !detected.hasFont
          && !detected.hasFactoryGuard
          && !detected.hasSwupdateHook
          && !detected.hasLibepaperBackup
        ) {
          send("log", { line: "감지: 설치된 한글 입력 구성 요소가 없습니다" });
          send("step", { step: 0, name: "설치 상태 감지", status: "complete" });
          send("progress", { percent: 100, step: 0 });
          send("complete", { success: true });
          return;
        }

        send("step", { step: 0, name: "설치 상태 감지", status: "complete" });
        send("progress", { percent: 10, step: 0 });

        // === Step 1: 서비스 중지 ===
        send("step", { step: 1, name: "서비스 중지", status: "running" });
        send("progress", { percent: 15, step: 1 });

        // 모든 REKOIT 관련 서비스를 중지 + disable + mask
        // mask는 /dev/null 심링크를 생성하여 daemon-reload 후에도 절대 실행 불가능하게 함
        // overlay 캐시에 서비스 파일이 남아있어도 mask 상태면 systemd가 무시함
        await runSsh(ip, password, `
          for svc in rekoit-factory-guard hangul-daemon rekoit-restore rekoit-bt-agent rekoit-bt-wake-reconnect; do
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
            systemctl mask "$svc" 2>/dev/null || true
          done
          killall hangul-daemon 2>/dev/null || true
        `);
        send("log", { line: "OK: REKOIT 서비스 전체 중지/비활성화/mask" });

        if (detected.btInstalled || detected.hasKeyboardPairings) {
          const btCleanupResult = await runSsh(ip, password, buildBluetoothKeyboardCleanupScript());
          const removedCountMatch = btCleanupResult.match(/BT_KEYBOARD_REMOVED_COUNT=(\d+)/);
          const removedCount = removedCountMatch ? Number.parseInt(removedCountMatch[1], 10) : 0;
          send("log", { line: `OK: 블루투스 키보드 페어링 정리 (${removedCount}개)` });

          await runSsh(ip, password, "systemctl stop bluetooth.service 2>/dev/null || true");
          send("log", { line: "OK: bluetooth.service 중지" });
        }

        send("step", { step: 1, name: "서비스 중지", status: "complete" });
        send("progress", { percent: 25, step: 1 });

        // === Step 2+3: 블록 디바이스 직접 마운트로 복원 + 삭제 통합 ===
        // 핵심: 모든 ext4 쓰기를 direct mount 한 곳에서만 수행
        // root mount(/)와 direct mount(/mnt/direct_rootfs)에 동시 쓰기하면 페이지 캐시 비일관성 발생
        // /etc는 overlay(tmpfs upperdir) → 일반 rm은 whiteout만 생성, 리부트 시 복원됨
        // /usr, /opt은 overlay 아니지만 같은 블록 디바이스이므로 direct mount로 통합
        send("step", { step: 2, name: "시스템 파일 제거", status: "running" });
        send("progress", { percent: 30, step: 2 });

        const directResult = await runSsh(ip, password, `
          LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
          LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"

          unmount_libepaper_mounts() {
            if grep -q " $LIBEPAPER " /proc/mounts 2>/dev/null; then
              umount "$LIBEPAPER" 2>/dev/null || true
            fi
            while mount | grep -q "$LIBEPAPER_TMPFS"; do
              TARGET=$(mount | awk -v src="$LIBEPAPER_TMPFS" '$1==src {print $3; exit}')
              [ -n "$TARGET" ] || break
              umount "$TARGET" 2>/dev/null || true
            done
          }

          unmount_libepaper_mounts
          rm -f "$LIBEPAPER_TMPFS"

          # 루트 파티션의 실제 블록 디바이스 찾기
          ROOTDEV=""
          for dev in /dev/mmcblk0p2 /dev/mmcblk0p3; do
            if mount | grep -q "$dev on / "; then
              ROOTDEV="$dev"
              break
            fi
          done
          if [ -z "$ROOTDEV" ]; then
            ROOTDEV=$(findmnt -n -o SOURCE / 2>/dev/null | head -1)
          fi
          echo "ROOTDEV=$ROOTDEV"

          if [ -z "$ROOTDEV" ] || [ "$ROOTDEV" = "overlay" ] || [ "$ROOTDEV" = "tmpfs" ]; then
            echo "DIRECT_MOUNT_FAIL: no block device found"
            exit 1
          fi

          mkdir -p /mnt/direct_rootfs
          umount /mnt/direct_rootfs 2>/dev/null || true
          mount -o rw "$ROOTDEV" /mnt/direct_rootfs 2>&1

          if [ ! -d /mnt/direct_rootfs/etc ]; then
            echo "DIRECT_MOUNT_FAIL: /mnt/direct_rootfs/etc not found"
            umount /mnt/direct_rootfs 2>/dev/null || true
            exit 1
          fi
          echo "DIRECT_MOUNT_OK"

          # === libepaper.so 원본 복원 (direct mount 경유) ===
          ${detected.hasLibepaperBackup ? `
          if [ -f "/home/root/rekoit/backup/libepaper.so.original" ]; then
            cp "/home/root/rekoit/backup/libepaper.so.original" /mnt/direct_rootfs/usr/lib/plugins/platforms/libepaper.so 2>/dev/null || true
            echo "LIBEPAPER_RESTORED"
          fi
          ` : ""}

          # === /etc 파일 삭제 (overlay 우회) ===
          rm -f /mnt/direct_rootfs/etc/systemd/system/hangul-daemon.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/rekoit-restore.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/rekoit-factory-guard.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/rekoit-bt-agent.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/rekoit-bt-wake-reconnect.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
          rm -rf /mnt/direct_rootfs/etc/systemd/system/bluetooth.service.d 2>/dev/null
          rm -f /mnt/direct_rootfs/etc/swupdate/conf.d/99-rekoit-postupdate
          rm -f /mnt/direct_rootfs/etc/modules-load.d/btnxpuart.conf

          # === /opt/rekoit 삭제 (direct mount 경유) ===
          rm -rf /mnt/direct_rootfs/opt/rekoit 2>/dev/null

          # === 폰트 삭제 (direct mount 경유) ===
          ${buildFontRemovalCommands({ deleteFont, prefix: "/mnt/direct_rootfs" })}

          # === bluetooth 설정 원복 (direct mount 경유) ===
          sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/direct_rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
          sed -i '/^Privacy = off$/d' /mnt/direct_rootfs/etc/bluetooth/main.conf 2>/dev/null || true
          sed -i '/^FastConnectable = true$/d' /mnt/direct_rootfs/etc/bluetooth/main.conf 2>/dev/null || true

          sync

          # === 통합 검증 (direct mount에서 확인) ===
          echo "POST_RM_CHECK:"
          [ -d /mnt/direct_rootfs/opt/rekoit ] && echo "STILL:/opt/rekoit" || echo "GONE:/opt/rekoit"
          [ -f /mnt/direct_rootfs${HANGUL_FONT_PATH} ] && echo "STILL:font" || echo "GONE:font"
          [ -f /mnt/direct_rootfs/etc/systemd/system/rekoit-factory-guard.service ] && echo "STILL:rekoit-factory-guard.service" || echo "GONE:rekoit-factory-guard.service"
          [ -f /mnt/direct_rootfs/etc/swupdate/conf.d/99-rekoit-postupdate ] && echo "STILL:swupdate-hook" || echo "GONE:swupdate-hook"
          [ -f /mnt/direct_rootfs/etc/modules-load.d/btnxpuart.conf ] && echo "STILL:btnxpuart" || echo "GONE:btnxpuart"

          umount /mnt/direct_rootfs 2>/dev/null || true
          echo "DIRECT_REMOVE_DONE"
        `);

        // 결과 파싱
        const stillExists = directResult.split("\n").filter((l) => l.startsWith("STILL:"));
        const goneItems = directResult.split("\n").filter((l) => l.startsWith("GONE:"));

        if (directResult.includes("DIRECT_MOUNT_OK")) {
          send("log", { line: "OK: 블록 디바이스 직접 마운트 성공" });
        }

        if (directResult.includes("LIBEPAPER_RESTORED")) {
          send("log", { line: "OK: libepaper.so 원본 복원" });
        }

        // 파일 삭제 결과
        if (stillExists.length > 0) {
          for (const item of stillExists) {
            send("log", { line: `WARNING: 삭제 실패 — ${item.replace("STILL:", "")}` });
          }
        }

        if (directResult.includes("GONE:/opt/rekoit")) {
          send("log", { line: "OK: /opt/rekoit 제거" });
        }
        if (deleteFont) {
          if (directResult.includes("GONE:font")) {
            send("log", { line: "OK: 한글 폰트 삭제" });
          } else {
            send("log", { line: "WARNING: 한글 폰트 삭제 실패" });
          }
        } else if (detected.hasFont) {
          if (directResult.includes("STILL:font")) {
            send("log", { line: "OK: 한글 폰트 유지" });
          } else {
            send("log", { line: "WARNING: 한글 폰트 유지 실패" });
          }
        } else {
          send("log", { line: "INFO: 유지할 한글 폰트가 현재 설치되어 있지 않음" });
        }

        if (directResult.includes("DIRECT_REMOVE_DONE")) {
          send("log", { line: `OK: ext4 파일 제거 완료 (${goneItems.length}개 삭제)` });
        } else {
          send("log", { line: "ERROR: 블록 디바이스 직접 마운트 실패" });
          for (const line of directResult.split("\n").filter((l) => l.trim())) {
            send("log", { line: `DIAG: ${line.trim()}` });
          }
        }

        if (detected.hasSwupdateHook) {
          send("log", { line: "OK: SWUpdate hook 제거 (ext4에서 삭제됨)" });
        }

        send("step", { step: 2, name: "시스템 파일 제거", status: "complete" });
        send("progress", { percent: 50, step: 2 });

        // === Step 3: overlay 정리 + daemon-reload (현재 세션 반영용) ===
        // root mount에서는 overlay /etc 파일만 rm (tmpfs에만 영향, ext4 쓰기 없음)
        send("step", { step: 3, name: "overlay 정리", status: "running" });
        send("progress", { percent: 55, step: 3 });

        await runSsh(ip, password, `
          # overlay /etc 파일 rm (현재 세션 즉시 반영용 — 리부트 후에는 direct mount 삭제가 유효)
          rm -f /etc/systemd/system/hangul-daemon.service /etc/systemd/system/rekoit-restore.service /etc/systemd/system/rekoit-factory-guard.service /etc/systemd/system/rekoit-bt-agent.service /etc/systemd/system/rekoit-bt-wake-reconnect.service
          rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service /etc/systemd/system/multi-user.target.wants/rekoit-restore.service /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
          rm -rf /etc/systemd/system/bluetooth.service.d 2>/dev/null
          rm -f /etc/swupdate/conf.d/99-rekoit-postupdate /etc/modules-load.d/btnxpuart.conf
          rm -rf /opt/rekoit 2>/dev/null || true
          ${buildFontRemovalCommands({ deleteFont, ignoreMissing: true, refreshCache: true })}
          sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
          sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
          sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true
          STATE_DIR="/home/root/rekoit"
          STATE_FILE="$STATE_DIR/install-state.conf"
          if [ -d "$STATE_DIR" ]; then
            cat > "$STATE_FILE" <<'STATE_EOF'
INSTALL_HANGUL=0
INSTALL_BT=0
BLUETOOTH_POWER_ON=0
SWAP_LEFT_CTRL_CAPSLOCK=0
KEYBOARD_LOCALES=
STATE_EOF
          fi
          for svc in rekoit-factory-guard hangul-daemon rekoit-restore rekoit-bt-agent rekoit-bt-wake-reconnect; do
            systemctl mask "$svc" 2>/dev/null || true
          done
          systemctl daemon-reload && sync
        `);
        send("log", { line: "OK: overlay 정리 + install-state 초기화 + daemon-reload" });

        send("step", { step: 3, name: "overlay 정리", status: "complete" });
        send("progress", { percent: 60, step: 3 });

        // === Step 4: 설치된 파일 제거 ===
        send("step", { step: 4, name: "설치 파일 제거", status: "running" });
        send("progress", { percent: 65, step: 4 });

        // SSH 재연결 확인 (swupdate 재시작으로 기기가 리부트되었을 수 있음)
        let step4Connected = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            await runSshOnce(ip, password, "echo OK");
            step4Connected = true;
            break;
          } catch {
            if (attempt === 0) {
              send("log", { line: "INFO: SSH 재연결 대기 중..." });
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        if (!step4Connected) {
          send("log", { line: "ERROR: SSH 재연결 실패 — 일부 정리 작업과 검증을 수행하지 못했습니다" });
          send("error", { message: "SSH 재연결 실패로 원상복구 검증을 완료하지 못했습니다" });
          return;
        }

        // .bashrc 정리
        await runSsh(ip, password, `
          rm -f /home/root/.rekoit-restore-login.sh 2>/dev/null || true
          if [ -f /home/root/.profile ]; then
            sed -i '\\|/home/root/.rekoit-restore-login.sh|d' /home/root/.profile 2>/dev/null || true
          fi
          if [ -f /home/root/.bashrc ]; then
            sed -i '/# Hangul auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true
            sed -i '/# REKOIT auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true
          fi
          systemctl stop bluetooth.service 2>/dev/null || true
        `);

        send("step", { step: 4, name: "설치 파일 제거", status: "complete" });
        send("progress", { percent: 75, step: 4 });

        // === Step 5: 비활성 파티션 정리 ===
        send("step", { step: 5, name: "비활성 파티션 정리", status: "running" });
        send("progress", { percent: 80, step: 5 });

        await runSsh(ip, password, `
          CURRENT=$(mount | grep ' / ' | head -n 1 | awk '{print $1}')
          case "$CURRENT" in
            /dev/mmcblk0p2) INACTIVE=/dev/mmcblk0p3 ;;
            /dev/mmcblk0p3) INACTIVE=/dev/mmcblk0p2 ;;
            *) INACTIVE="" ;;
          esac
          if [ -n "$INACTIVE" ]; then
            mkdir -p /mnt/inactive
            mount -o rw "$INACTIVE" /mnt/inactive 2>/dev/null || true
            if [ -d /mnt/inactive/etc ]; then
              rm -rf /mnt/inactive/opt/rekoit
              ${buildFontRemovalCommands({ deleteFont, prefix: "/mnt/inactive" })}
              rm -f /mnt/inactive/etc/swupdate/conf.d/99-rekoit-postupdate
              rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
              rm -f /mnt/inactive/etc/systemd/system/rekoit-restore.service
              rm -f /mnt/inactive/etc/systemd/system/rekoit-factory-guard.service
              rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-agent.service
              rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-wake-reconnect.service
              rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
              rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
              rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
              rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
              rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
              rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
              rm -rf /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
              sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
              sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
              sed -i '/^FastConnectable = true$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
              rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
              sync
            fi
            umount /mnt/inactive 2>/dev/null || true
          fi
        `);
        send("log", { line: "OK: 비활성 파티션 REKOIT 흔적 제거" });

        send("step", { step: 5, name: "비활성 파티션 정리", status: "complete" });
        send("progress", { percent: 85, step: 5 });

        // === Step 6: 설치 디렉토리 및 최종 정리 ===
        send("step", { step: 6, name: "설치 디렉토리 정리", status: "running" });
        send("progress", { percent: 88, step: 6 });

        if (cleanupFiles) {
          await runSsh(ip, password, `
            find /home/root/rekoit -type f -delete 2>/dev/null || true
            find /home/root/rekoit -type d -empty -delete 2>/dev/null || true
            rm -rf /home/root/rekoit 2>/dev/null || true
          `);
          send("log", { line: "OK: /home/root/REKOIT 디렉토리 제거" });
        }

        // daemon-reload 전에 mask 재확인 — overlay 캐시 서비스가 로드되지 않도록
        await runSsh(ip, password, `
          for svc in rekoit-factory-guard hangul-daemon rekoit-restore rekoit-bt-agent rekoit-bt-wake-reconnect; do
            systemctl mask "$svc" 2>/dev/null || true
          done
          systemctl daemon-reload && sync
        `);
        send("log", { line: "OK: REKOIT 서비스 mask 재확인 + daemon-reload" });

        send("step", { step: 6, name: "설치 디렉토리 정리", status: "complete" });
        send("progress", { percent: 93, step: 6 });

        // === Step 7: xochitl 재시작 (마지막 — SSH 연결 끊김 예상) ===
        send("step", { step: 7, name: "시스템 재시작", status: "running" });
        send("progress", { percent: 95, step: 7 });

        try {
          // xochitl restart 시 USB 네트워크가 일시적으로 끊기므로, 
          // 2초 뒤에 백그라운드에서 실행되도록 하여 SSH 세션이 먼저 정상 종료되게 함
          await runSsh(ip, password, `
            for svc in rekoit-factory-guard hangul-daemon rekoit-restore rekoit-bt-agent rekoit-bt-wake-reconnect; do
              systemctl mask "$svc" 2>/dev/null || true
            done
            sync && (sleep 2 && systemctl restart xochitl) &
          `);
          send("log", { line: "OK: xochitl 재시작 명령 전송 완료 (2초 뒤 실행)" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send("log", { line: `WARNING: xochitl 재시작 명령 전송 중 오류 (무시됨): ${msg}` });
        }

        send("step", { step: 7, name: "시스템 재시작", status: "complete" });
        send("progress", { percent: 96, step: 7 });

        // === Step 8: 재시작 후 삭제 검증 ===
        send("step", { step: 8, name: "삭제 검증", status: "running" });
        send("progress", { percent: 97, step: 8 });

        // SSH 재연결 대기 (xochitl 재시작 후 USB 네트워크 복구까지 최대 20초)
        let verifyOutput = "";
        let verified = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            send("log", { line: "INFO: 삭제 검증 시도 중..." });
            verifyOutput = await runSshOnce(ip, password, `
              # 최종 live cleanup: active rootfs의 현재 런타임 뷰를 다시 한 번 강제 정리
              rm -rf /opt/rekoit 2>/dev/null || true
              # 서비스 unmask 최종 확인 (xochitl 재시작 시점에 mask되어 있었음)
              for svc in rekoit-factory-guard hangul-daemon rekoit-restore rekoit-bt-agent rekoit-bt-wake-reconnect; do
                systemctl stop "$svc" 2>/dev/null || true
                systemctl disable "$svc" 2>/dev/null || true
                systemctl unmask "$svc" 2>/dev/null || true
              done
              systemctl daemon-reload 2>/dev/null || true

              echo "=== VERIFY ==="

              # 모든 rootfs 파일을 direct mount로 확인 (overlay/페이지캐시 우회)
              ROOTDEV=""
              for dev in /dev/mmcblk0p2 /dev/mmcblk0p3; do
                if mount | grep -q "$dev on / "; then
                  ROOTDEV="$dev"
                  break
                fi
              done
              if [ -z "$ROOTDEV" ]; then
                ROOTDEV=$(findmnt -n -o SOURCE / 2>/dev/null | grep mmcblk | head -1)
              fi

              DIRECT=""
              if [ -n "$ROOTDEV" ]; then
                mkdir -p /mnt/verify_rootfs
                umount /mnt/verify_rootfs 2>/dev/null || true
                mount -o ro "$ROOTDEV" /mnt/verify_rootfs 2>/dev/null
                if [ -d /mnt/verify_rootfs/etc ]; then
                  DIRECT="/mnt/verify_rootfs"
                  echo "VERIFY_DIRECT_MOUNT_OK"
                fi
              fi

              if [ -n "$DIRECT" ]; then
                # /etc 파일 확인 (ext4 직접)
                [ -f "$DIRECT/etc/systemd/system/hangul-daemon.service" ] && echo "REMAIN:hangul-daemon.service 파일" || true
                [ -f "$DIRECT/etc/systemd/system/rekoit-restore.service" ] && echo "REMAIN:rekoit-restore.service 파일" || true
                [ -f "$DIRECT/etc/systemd/system/rekoit-factory-guard.service" ] && echo "REMAIN:rekoit-factory-guard.service 파일" || true
                [ -f "$DIRECT/etc/systemd/system/rekoit-bt-agent.service" ] && echo "REMAIN:rekoit-bt-agent.service 파일" || true
                [ -f "$DIRECT/etc/systemd/system/rekoit-bt-wake-reconnect.service" ] && echo "REMAIN:rekoit-bt-wake-reconnect.service 파일" || true
                [ -f "$DIRECT/etc/swupdate/conf.d/99-rekoit-postupdate" ] && echo "REMAIN:swupdate hook 파일" || true
                [ -f "$DIRECT/etc/modules-load.d/btnxpuart.conf" ] && echo "REMAIN:btnxpuart 모듈 설정" || true

                # rootfs 파일 확인 (direct mount 경유 — root mount 캐시 우회)
                [ -f "$DIRECT${HANGUL_FONT_PATH}" ] && echo "REMAIN:한글 폰트 파일" || true
                ${!deleteFont && detected.hasFont ? `[ -f "$DIRECT${HANGUL_FONT_PATH}" ] || echo "MISSING:한글 폰트 파일"` : ""}
                [ -d "$DIRECT/opt/rekoit" ] && echo "REMAIN:/opt/rekoit 디렉토리" || true
              else
                # direct mount 실패 시 root mount로 fallback
                [ -f ${HANGUL_FONT_PATH} ] && echo "REMAIN:한글 폰트 파일" || true
                ${!deleteFont && detected.hasFont ? `[ -f ${HANGUL_FONT_PATH} ] || echo "MISSING:한글 폰트 파일"` : ""}
                [ -d /opt/rekoit ] && echo "REMAIN:/opt/rekoit 디렉토리" || true
              fi

              # /home 파일 확인 (별도 파티션 — overlay 아님)
              [ -d /home/root/rekoit ] && echo "REMAIN:rekoit 디렉토리" || true
              [ -d /home/root/rekoit/bt-pairing ] && echo "REMAIN:bt-pairing 백업 디렉토리" || true
              if [ -f /home/root/rekoit/install-state.conf ]; then
                . /home/root/rekoit/install-state.conf
                [ "\${INSTALL_HANGUL:-1}" = "0" ] || echo "REMAIN:install-state hangul flag"
                [ "\${INSTALL_BT:-1}" = "0" ] || echo "REMAIN:install-state bt flag"
              fi
              grep -q 'rekoit' /home/root/.bashrc 2>/dev/null && echo "REMAIN:.bashrc 자동복구 스크립트" || true
              [ -f /dev/shm/hangul-libepaper.so ] && echo "REMAIN:libepaper tmpfs 파일" || true
              mount | grep -q ' /usr/lib/plugins/platforms/libepaper.so ' && echo "REMAIN:libepaper runtime mount" || true

              # 블루투스 확인 (bluetoothctl 배제 — 서비스 중지 시 hang 위험)
              find /var/lib/bluetooth -mindepth 2 -maxdepth 2 -type d 2>/dev/null | awk -F/ '
                /^[0-9A-F:]{17}$/ && $(NF-1) != "cache" {print $NF}
              ' | while read ADDR; do
                echo "REMAIN:블루투스 디바이스 상태 ($ADDR)"
              done

              if [ -n "$DIRECT" ]; then
                umount /mnt/verify_rootfs 2>/dev/null || true
              fi

              echo "VERIFY_DONE"
            `);
            verified = true;
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send("log", { line: `INFO: SSH 재연결 대기 중... (${attempt + 1}/8) - ${msg}` });
          }
        }

        if (verified && verifyOutput.includes("VERIFY_DONE")) {
          const remains = verifyOutput
            .split("\n")
            .filter((line) => line.startsWith("REMAIN:"))
            .map((line) => line.replace("REMAIN:", "").trim());
          const missing = verifyOutput
            .split("\n")
            .filter((line) => line.startsWith("MISSING:"))
            .map((line) => line.replace("MISSING:", "").trim());

          // 폰트 유지 선택 시 폰트 관련 항목 제외
          const filtered = deleteFont
            ? remains
            : remains.filter((r) => !r.includes("한글 폰트"));

          if (filtered.length === 0) {
            send("log", { line: "OK: 전체 검증 완료 — 모든 항목 정상 삭제됨" });
          } else {
            for (const item of filtered) {
              send("log", { line: `WARNING: 미삭제 항목 — ${item}` });
            }
            send("log", { line: `WARNING: ${filtered.length}개 항목이 완전히 삭제되지 않았습니다` });
          }

          for (const item of missing) {
            send("log", { line: `WARNING: 보존 실패 — ${item}` });
          }
        } else {
          send("log", { line: "WARNING: SSH 재연결 실패 — 삭제 검증을 수행할 수 없습니다" });
        }

        send("step", { step: 8, name: "삭제 검증", status: "complete" });
        send("progress", { percent: 100, step: 8 });
        send("complete", { success: true });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        send("error", { message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

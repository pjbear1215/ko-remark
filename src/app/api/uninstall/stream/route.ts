import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import { isOriginalRestoreVerified } from "@/lib/reversibility.js";
import {
  buildBluetoothKeyboardCleanupScript,
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
  keypadInstalled: boolean;
  btInstalled: boolean;
  hasKeyboardPairings: boolean;
  hasXochitlBackup: boolean;
  hasLibepaperBackup: boolean;
  hasFactoryGuard: boolean;
  hasSwupdateHook: boolean;
  hasFont: boolean;
  hasKbds: boolean;
}

async function detectInstallation(
  ip: string,
  password: string,
): Promise<DetectionResult> {
  const output = await runSsh(
    ip,
    password,
    `echo "=== DETECT ==="
    # xochitl 패치 여부
    strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "KEYPAD=yes" || echo "KEYPAD=no"

    # BT 데몬 존재 여부
    if [ -f /home/root/bt-keyboard/hangul-daemon ] || systemctl is-enabled hangul-daemon 2>/dev/null | grep -q enabled; then
      echo "BT=yes"
    else
      echo "BT=no"
    fi

    KEYBOARD_BT_COUNT=0
    for ADDR in $( (
      bluetoothctl devices Paired 2>/dev/null || true
      bluetoothctl devices Trusted 2>/dev/null || true
      bluetoothctl devices Connected 2>/dev/null || true
    ) | awk '{print $2}' | sort -u ); do
      INFO=$(bluetoothctl info "$ADDR" 2>/dev/null || true)
      case "$INFO" in
        *"Icon: input-keyboard"*|*"UUID: Human Interface Device"*)
          KEYBOARD_BT_COUNT=$((KEYBOARD_BT_COUNT + 1))
          ;;
      esac
    done
    [ "$KEYBOARD_BT_COUNT" -gt 0 ] && echo "KEYBOARD_BT=yes" || echo "KEYBOARD_BT=no"

    # xochitl 원본 백업
    if [ -f /home/root/bt-keyboard/backup/xochitl.original ] || [ -f /opt/bt-keyboard/xochitl.original ]; then
      echo "XOCHITL_BACKUP=yes"
    else
      echo "XOCHITL_BACKUP=no"
    fi

    # libepaper 백업
    [ -f /home/root/bt-keyboard/backup/libepaper.so.original ] && echo "LIBEPAPER_BACKUP=yes" || echo "LIBEPAPER_BACKUP=no"

    # factory-guard
    [ -f /opt/bt-keyboard/factory-guard.sh ] && echo "FACTORY_GUARD=yes" || echo "FACTORY_GUARD=no"

    # swupdate conf.d hook
    [ -f /etc/swupdate/conf.d/99-hangul-postupdate ] && echo "SWUPDATE_HOOK=yes" || echo "SWUPDATE_HOOK=no"

    # 한글 폰트
    [ -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf ] && echo "FONT=yes" || echo "FONT=no"

    # .kbds 디렉토리
    [ -d /home/root/.kbds ] && echo "KBDS=yes" || echo "KBDS=no"`,
  );

  const get = (key: string): boolean => output.includes(`${key}=yes`);

  return {
    keypadInstalled: get("KEYPAD"),
    btInstalled: get("BT"),
    hasKeyboardPairings: get("KEYBOARD_BT"),
    hasXochitlBackup: get("XOCHITL_BACKUP"),
    hasLibepaperBackup: get("LIBEPAPER_BACKUP"),
    hasFactoryGuard: get("FACTORY_GUARD"),
    hasSwupdateHook: get("SWUPDATE_HOOK"),
    hasFont: get("FONT"),
    hasKbds: get("KBDS"),
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
        // === Step 0: 설치 상태 감지 ===
        send("step", { step: 0, name: "설치 상태 감지", status: "running" });
        send("progress", { percent: 5, step: 0 });

        const detected = await detectInstallation(ip, password);

        // 감지 결과 전송
        send("detect", {
          keypad: detected.keypadInstalled,
          bt: detected.btInstalled,
          factoryGuard: detected.hasFactoryGuard,
          swupdateHook: detected.hasSwupdateHook,
          keyboardBt: detected.hasKeyboardPairings,
        });

        if (detected.keypadInstalled) {
      send("log", { line: "감지: 기존 설치 상태 확인됨" });
        }
        if (detected.btInstalled) {
          send("log", { line: "감지: 블루투스 한글 키보드 설치됨" });
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
        if (!detected.keypadInstalled && !detected.btInstalled && !detected.hasKeyboardPairings) {
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

        // 모든 hangul 관련 서비스를 중지 + disable + mask
        // mask는 /dev/null 심링크를 생성하여 daemon-reload 후에도 절대 실행 불가능하게 함
        // overlay 캐시에 서비스 파일이 남아있어도 mask 상태면 systemd가 무시함
        await runSsh(ip, password, `
          for svc in hangul-factory-guard hangul-daemon hangul-restore; do
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
            systemctl mask "$svc" 2>/dev/null || true
          done
          killall hangul-daemon 2>/dev/null || true
        `);
        send("log", { line: "OK: hangul 관련 서비스 전체 중지/비활성화/mask" });

        if (detected.keypadInstalled) {
          await runSsh(ip, password, "systemctl stop xochitl 2>/dev/null || true");
          send("log", { line: "OK: xochitl 중지" });
        }

        if (detected.btInstalled || detected.hasKeyboardPairings) {
          const btCleanupResult = await runSsh(ip, password, buildBluetoothKeyboardCleanupScript());
          const removedCountMatch = btCleanupResult.match(/BT_KEYBOARD_REMOVED_COUNT=(\d+)/);
          const removedCount = removedCountMatch ? Number.parseInt(removedCountMatch[1], 10) : 0;
          send("log", { line: `OK: 블루투스 키보드 페어링 정리 (${removedCount}개)` });
        }

        send("step", { step: 1, name: "서비스 중지", status: "complete" });
        send("progress", { percent: 25, step: 1 });

        // === Step 2+3: 블록 디바이스 직접 마운트로 복원 + 삭제 통합 ===
        // 핵심: 모든 ext4 쓰기를 direct mount 한 곳에서만 수행
        // root mount(/)와 direct mount(/mnt/direct_rootfs)에 동시 쓰기하면 페이지 캐시 비일관성 발생
        // /etc는 overlay(tmpfs upperdir) → 일반 rm은 whiteout만 생성, 리부트 시 복원됨
        // /usr, /opt은 overlay 아니지만 같은 블록 디바이스이므로 direct mount로 통합
        send("step", { step: 2, name: "xochitl 원본 복원 + 시스템 파일 제거", status: "running" });
        send("progress", { percent: 30, step: 2 });

        const directResult = await runSsh(ip, password, `
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

          # === xochitl 원본 복원 (direct mount 경유) ===
          RESTORED="NO"
          ${detected.keypadInstalled ? `
          BACKUP=""
          if [ -f "/home/root/bt-keyboard/backup/xochitl.original" ]; then
            BACKUP="/home/root/bt-keyboard/backup/xochitl.original"
          elif [ -f "/mnt/direct_rootfs/opt/bt-keyboard/xochitl.original" ]; then
            BACKUP="/mnt/direct_rootfs/opt/bt-keyboard/xochitl.original"
          fi

          # 1차: 백업 파일에서 복원
          if [ -n "$BACKUP" ]; then
            if strings "$BACKUP" 2>/dev/null | grep -q ":/misc/keyboards/"; then
              cp "$BACKUP" /mnt/direct_rootfs/usr/bin/xochitl && chmod 755 /mnt/direct_rootfs/usr/bin/xochitl && RESTORED="BACKUP"
            else
              echo "BACKUP_INVALID"
            fi
          fi

          # 2차: 백업 실패 시 비활성 파티션에서 복원
          if [ "$RESTORED" = "NO" ]; then
            CURRENT=$(mount | grep ' / ' | awk '{print $1}')
            case "$CURRENT" in
              /dev/mmcblk0p2) INACTIVE=/dev/mmcblk0p3 ;;
              /dev/mmcblk0p3) INACTIVE=/dev/mmcblk0p2 ;;
              *) INACTIVE="" ;;
            esac
            if [ -n "$INACTIVE" ]; then
              mkdir -p /mnt/inactive_src
              umount /mnt/inactive_src 2>/dev/null || true
              mount -o ro "$INACTIVE" /mnt/inactive_src 2>/dev/null
              if [ -f /mnt/inactive_src/usr/bin/xochitl ]; then
                if strings /mnt/inactive_src/usr/bin/xochitl 2>/dev/null | grep -q ":/misc/keyboards/"; then
                  cp /mnt/inactive_src/usr/bin/xochitl /mnt/direct_rootfs/usr/bin/xochitl && chmod 755 /mnt/direct_rootfs/usr/bin/xochitl && RESTORED="INACTIVE"
                fi
              fi
              umount /mnt/inactive_src 2>/dev/null || true
            fi
          fi
          ` : ""}

          # === libepaper.so 원본 복원 (direct mount 경유) ===
          ${detected.hasLibepaperBackup ? `
          if [ -f "/home/root/bt-keyboard/backup/libepaper.so.original" ]; then
            cp "/home/root/bt-keyboard/backup/libepaper.so.original" /mnt/direct_rootfs/usr/lib/plugins/platforms/libepaper.so 2>/dev/null || true
            echo "LIBEPAPER_RESTORED"
          fi
          ` : ""}

          # === /etc 파일 삭제 (overlay 우회) ===
          rm -f /mnt/direct_rootfs/etc/systemd/system/xochitl.service.d/override.conf
          rm -f /mnt/direct_rootfs/etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
          rm -rf /mnt/direct_rootfs/etc/systemd/system/xochitl.service.d 2>/dev/null
          rm -f /mnt/direct_rootfs/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
          rm -f /mnt/direct_rootfs/etc/systemd/system/hangul-daemon.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/hangul-restore.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/hangul-factory-guard.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/hangul-restore.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
          rm -f /mnt/direct_rootfs/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
          rm -rf /mnt/direct_rootfs/etc/systemd/system/bluetooth.service.d 2>/dev/null
          rm -f /mnt/direct_rootfs/etc/swupdate/conf.d/99-hangul-postupdate
          rm -f /mnt/direct_rootfs/etc/modules-load.d/btnxpuart.conf

          # === /opt/bt-keyboard 삭제 (direct mount 경유) ===
          rm -rf /mnt/direct_rootfs/opt/bt-keyboard 2>/dev/null

          # === 폰트 삭제 (direct mount 경유) ===
          ${buildFontRemovalCommands({ deleteFont, prefix: "/mnt/direct_rootfs" })}

          # === bluetooth 설정 원복 (direct mount 경유) ===
          sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/direct_rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
          sed -i '/^Privacy = off$/d' /mnt/direct_rootfs/etc/bluetooth/main.conf 2>/dev/null || true

          sync

          # === 통합 검증 (direct mount에서 확인) ===
          echo "POST_RM_CHECK:"
          ${detected.keypadInstalled ? `
          if strings /mnt/direct_rootfs/usr/bin/xochitl 2>/dev/null | grep -q ":/misc/keyboards/"; then
            echo "VERIFY_ORIGINAL_OK"
          else
            if strings /mnt/direct_rootfs/usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/"; then
              echo "VERIFY_STILL_PATCHED"
            else
              echo "VERIFY_UNKNOWN"
            fi
          fi
          echo "RESTORED=$RESTORED"
          ` : ""}
          [ -d /mnt/direct_rootfs/opt/bt-keyboard ] && echo "STILL:/opt/bt-keyboard" || echo "GONE:/opt/bt-keyboard"
          [ -f /mnt/direct_rootfs${HANGUL_FONT_PATH} ] && echo "STILL:font" || echo "GONE:font"
          [ -f /mnt/direct_rootfs/etc/systemd/system/hangul-factory-guard.service ] && echo "STILL:hangul-factory-guard.service" || echo "GONE:hangul-factory-guard.service"
          [ -f /mnt/direct_rootfs/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf ] && echo "STILL:xochitl hook drop-in" || echo "GONE:xochitl hook drop-in"
          [ -f /mnt/direct_rootfs/etc/swupdate/conf.d/99-hangul-postupdate ] && echo "STILL:swupdate-hook" || echo "GONE:swupdate-hook"
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

        // xochitl 복원 결과
        if (detected.keypadInstalled) {
          if (directResult.includes("VERIFY_ORIGINAL_OK")) {
            const source = directResult.includes("RESTORED=BACKUP") ? "백업" : directResult.includes("RESTORED=INACTIVE") ? "비활성 파티션" : "알 수 없음";
            send("log", { line: `OK: xochitl 원본 복원 완료 (소스: ${source}, 검증 통과)` });
          } else if (directResult.includes("VERIFY_STILL_PATCHED")) {
            send("log", { line: "ERROR: xochitl 복원 실패 — 패치가 여전히 남아있음" });
          } else {
            send("log", { line: "WARNING: xochitl 복원 상태 불확실 — 수동 확인 권장" });
          }
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

        if (directResult.includes("GONE:/opt/bt-keyboard")) {
          send("log", { line: "OK: /opt/bt-keyboard 제거" });
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

        if (detected.keypadInstalled && !isOriginalRestoreVerified(directResult)) {
          throw new Error(
            "xochitl restore verification failed: keyboard path did not return to :/misc/keyboards/",
          );
        }

        send("step", { step: 2, name: "xochitl 원본 복원 + 시스템 파일 제거", status: "complete" });
        send("progress", { percent: 50, step: 2 });

        // === Step 3: overlay 정리 + daemon-reload (현재 세션 반영용) ===
        // root mount에서는 overlay /etc 파일만 rm (tmpfs에만 영향, ext4 쓰기 없음)
        send("step", { step: 3, name: "overlay 정리", status: "running" });
        send("progress", { percent: 55, step: 3 });

        await runSsh(ip, password, `
          ${detected.keypadInstalled ? `
          if [ -f /opt/bt-keyboard/xochitl.original ]; then
            cp /opt/bt-keyboard/xochitl.original /usr/bin/xochitl 2>/dev/null || true
            chmod 755 /usr/bin/xochitl 2>/dev/null || true
          fi
          ` : ""}
          # overlay /etc 파일 rm (현재 세션 즉시 반영용 — 리부트 후에는 direct mount 삭제가 유효)
          rm -rf /etc/systemd/system/xochitl.service.d 2>/dev/null
          rm -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
          rm -f /etc/systemd/system/hangul-daemon.service /etc/systemd/system/hangul-restore.service /etc/systemd/system/hangul-factory-guard.service
          rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service /etc/systemd/system/multi-user.target.wants/hangul-restore.service /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
          rm -rf /etc/systemd/system/bluetooth.service.d 2>/dev/null
          rm -f /etc/swupdate/conf.d/99-hangul-postupdate /etc/modules-load.d/btnxpuart.conf
          rm -rf /opt/bt-keyboard 2>/dev/null || true
          ${buildFontRemovalCommands({ deleteFont, ignoreMissing: true, refreshCache: true })}
          sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
          sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
          for svc in hangul-factory-guard hangul-daemon hangul-restore; do
            systemctl mask "$svc" 2>/dev/null || true
          done
          systemctl daemon-reload && sync
        `);
        send("log", { line: "OK: overlay 정리 + daemon-reload" });

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
          send("log", { line: "WARNING: SSH 재연결 실패 — 일부 정리 작업을 건너뜁니다" });
          send("step", { step: 4, name: "설치 파일 제거", status: "complete" });
          send("progress", { percent: 100, step: 4 });
          send("complete", { success: true });
          return;
        }

        // .kbds 키보드 레이아웃 제거
        if (detected.hasKbds) {
          await runSsh(ip, password, "rm -rf /home/root/.kbds 2>/dev/null || true");
          send("log", { line: "OK: .kbds 키보드 레이아웃 제거" });
        }

        // 키보드 설정 복원 ([General] 섹션 안에 삽입)
        await runSsh(ip, password, `
          CONF="/home/root/.config/remarkable/xochitl.conf"
          if [ -f "$CONF" ]; then
            sed -i '/^Keyboard=/d' "$CONF"
            if grep -q '^\\[General\\]' "$CONF"; then
              sed -i '/^\\[General\\]/a\\Keyboard=en_US' "$CONF"
            else
              echo "Keyboard=en_US" >> "$CONF"
            fi
          fi
        `);
        send("log", { line: "OK: 키보드 설정 복원 (en_US)" });

        // .bashrc 정리
        await runSsh(ip, password, `
          if [ -f /home/root/.bashrc ] && grep -q 'bt-keyboard' /home/root/.bashrc 2>/dev/null; then
            rm -f /home/root/.bashrc
          fi
        `);

        send("step", { step: 4, name: "설치 파일 제거", status: "complete" });
        send("progress", { percent: 75, step: 4 });

        // === Step 6: 비활성 파티션 정리 (키패드만) ===
        if (detected.keypadInstalled) {
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
                if [ -f /mnt/inactive/opt/bt-keyboard/xochitl.original ]; then
                  cp /mnt/inactive/opt/bt-keyboard/xochitl.original /mnt/inactive/usr/bin/xochitl
                  chmod 755 /mnt/inactive/usr/bin/xochitl
                fi
                rm -rf /mnt/inactive/opt/bt-keyboard
                ${buildFontRemovalCommands({ deleteFont, prefix: "/mnt/inactive" })}
                rm -f /mnt/inactive/etc/swupdate/conf.d/99-hangul-postupdate
                rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/override.conf
                rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
                rm -rf /mnt/inactive/etc/systemd/system/xochitl.service.d 2>/dev/null || true
                rm -f /mnt/inactive/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
                rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
                rm -f /mnt/inactive/etc/systemd/system/hangul-restore.service
                rm -f /mnt/inactive/etc/systemd/system/hangul-factory-guard.service
                rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
                rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-restore.service
                rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
                rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
                rm -rf /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
                sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
                sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
                rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
                sync
              fi
              umount /mnt/inactive 2>/dev/null || true
            fi
          `);
          send("log", { line: "OK: 비활성 파티션 한글 흔적 제거" });

          send("step", { step: 5, name: "비활성 파티션 정리", status: "complete" });
          send("progress", { percent: 85, step: 5 });
        }

        // === Step 6: 설치 디렉토리 및 최종 정리 ===
        send("step", { step: 6, name: "설치 디렉토리 정리", status: "running" });
        send("progress", { percent: 88, step: 6 });

        if (cleanupFiles) {
          await runSsh(ip, password, `
            find /home/root/bt-keyboard -type f -delete 2>/dev/null || true
            find /home/root/bt-keyboard -type d -empty -delete 2>/dev/null || true
            rm -rf /home/root/bt-keyboard 2>/dev/null || true
          `);
          send("log", { line: "OK: /home/root/bt-keyboard 디렉토리 제거" });
        }

        // daemon-reload 전에 mask 재확인 — overlay 캐시 서비스가 로드되지 않도록
        await runSsh(ip, password, `
          for svc in hangul-factory-guard hangul-daemon hangul-restore; do
            systemctl mask "$svc" 2>/dev/null || true
          done
          systemctl daemon-reload && sync
        `);
        send("log", { line: "OK: hangul 서비스 mask 재확인 + daemon-reload" });

        send("step", { step: 6, name: "설치 디렉토리 정리", status: "complete" });
        send("progress", { percent: 93, step: 6 });

        // === Step 7: xochitl 재시작 (마지막 — SSH 연결 끊김 예상) ===
        send("step", { step: 7, name: "시스템 재시작", status: "running" });
        send("progress", { percent: 95, step: 7 });

        try {
          // xochitl restart 시 hangul 서비스가 트리거되지 않도록 최종 확인
          await runSsh(ip, password, `
            for svc in hangul-factory-guard hangul-daemon hangul-restore; do
              systemctl mask "$svc" 2>/dev/null || true
            done
            sync && systemctl restart xochitl 2>/dev/null || true
          `);
          send("log", { line: "OK: xochitl 재시작" });
        } catch {
          // xochitl 재시작 시 USB 네트워크가 끊겨 SSH 연결이 닫힐 수 있음 — 정상
          send("log", { line: "OK: xochitl 재시작 (연결 끊김 — 정상)" });
        }

        send("step", { step: 7, name: "시스템 재시작", status: "complete" });
        send("progress", { percent: 90, step: 7 });

        // === Step 8: 재시작 후 삭제 검증 ===
        send("step", { step: 8, name: "삭제 검증", status: "running" });
        send("progress", { percent: 92, step: 8 });

        // SSH 재연결 대기 (xochitl 재시작 후 USB 네트워크 복구까지 최대 40초)
        let verifyOutput = "";
        let verified = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            verifyOutput = await runSshOnce(ip, password, `
              # 최종 live cleanup: active rootfs의 현재 런타임 뷰를 다시 한 번 강제 정리
              if [ -f /opt/bt-keyboard/xochitl.original ]; then
                cp /opt/bt-keyboard/xochitl.original /usr/bin/xochitl 2>/dev/null || true
                chmod 755 /usr/bin/xochitl 2>/dev/null || true
              fi
              rm -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf 2>/dev/null || true
              ${buildFontRemovalCommands({ deleteFont, ignoreMissing: true, refreshCache: true })}
              rm -rf /opt/bt-keyboard 2>/dev/null || true
              systemctl stop hangul-daemon 2>/dev/null || true
              systemctl disable hangul-daemon 2>/dev/null || true
              rm -f /etc/systemd/system/hangul-daemon.service 2>/dev/null || true
              rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service 2>/dev/null || true
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
                [ -f "$DIRECT/etc/systemd/system/hangul-restore.service" ] && echo "REMAIN:hangul-restore.service 파일" || true
                [ -f "$DIRECT/etc/systemd/system/hangul-factory-guard.service" ] && echo "REMAIN:hangul-factory-guard.service 파일" || true
                [ -f "$DIRECT/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf" ] && echo "REMAIN:xochitl hook drop-in 파일" || true
                [ -f "$DIRECT/etc/swupdate/conf.d/99-hangul-postupdate" ] && echo "REMAIN:swupdate hook 파일" || true
                [ -f "$DIRECT/etc/modules-load.d/btnxpuart.conf" ] && echo "REMAIN:btnxpuart 모듈 설정" || true

                # rootfs 파일 확인 (direct mount 경유 — root mount 캐시 우회)
                strings "$DIRECT/usr/bin/xochitl" 2>/dev/null | grep -q "/home/root/.kbds/" && echo "REMAIN:xochitl 패치 미복원" || true
                [ -f "$DIRECT${HANGUL_FONT_PATH}" ] && echo "REMAIN:한글 폰트 파일" || true
                ${!deleteFont && detected.hasFont ? `[ -f "$DIRECT${HANGUL_FONT_PATH}" ] || echo "MISSING:한글 폰트 파일"` : ""}
                [ -d "$DIRECT/opt/bt-keyboard" ] && echo "REMAIN:/opt/bt-keyboard 디렉토리" || true
              else
                # direct mount 실패 시 root mount로 fallback
                strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "REMAIN:xochitl 패치 미복원" || true
                [ -f ${HANGUL_FONT_PATH} ] && echo "REMAIN:한글 폰트 파일" || true
                ${!deleteFont && detected.hasFont ? `[ -f ${HANGUL_FONT_PATH} ] || echo "MISSING:한글 폰트 파일"` : ""}
                [ -d /opt/bt-keyboard ] && echo "REMAIN:/opt/bt-keyboard 디렉토리" || true
              fi

              # /home 파일 확인 (별도 파티션 — overlay 아님)
              [ -d /home/root/.kbds ] && echo "REMAIN:.kbds 디렉토리" || true
              [ -d /home/root/bt-keyboard ] && echo "REMAIN:bt-keyboard 디렉토리" || true
              grep -q "^Keyboard=ko_KR" /home/root/.config/remarkable/xochitl.conf 2>/dev/null && echo "REMAIN:Keyboard=ko_KR 설정" || true
              grep -q 'bt-keyboard' /home/root/.bashrc 2>/dev/null && echo "REMAIN:.bashrc 자동복구 스크립트" || true

              for ADDR in $( (
                bluetoothctl devices Paired 2>/dev/null || true
                bluetoothctl devices Trusted 2>/dev/null || true
                bluetoothctl devices Connected 2>/dev/null || true
              ) | awk '{print $2}' | sort -u ); do
                INFO=$(bluetoothctl info "$ADDR" 2>/dev/null || true)
                case "$INFO" in
                  *"Icon: input-keyboard"*|*"UUID: Human Interface Device"*)
                    echo "REMAIN:블루투스 키보드 페어링 데이터 ($ADDR)"
                    ;;
                esac
              done

              # mask 해제 (재설치 시 문제 방지)
              for svc in hangul-factory-guard hangul-daemon hangul-restore; do
                systemctl unmask "$svc" 2>/dev/null || true
              done

              if [ -n "$DIRECT" ]; then
                umount /mnt/verify_rootfs 2>/dev/null || true
              fi

              echo "VERIFY_DONE"
            `);
            verified = true;
            break;
          } catch {
            send("log", { line: `INFO: SSH 재연결 대기 중... (${attempt + 1}/8)` });
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

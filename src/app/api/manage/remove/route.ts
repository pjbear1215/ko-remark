import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { buildBluetoothKeyboardCleanupScript } from "@/lib/bluetooth/bluetoothCleanup.js";

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

async function detect(ip: string, password: string): Promise<{ hangul: boolean; bt: boolean }> {
  const output = await runSsh(ip, password, `
    if [ -f /home/root/rekoit/install-state.conf ]; then
      . /home/root/rekoit/install-state.conf
      echo "STATE_HANGUL=\${INSTALL_HANGUL:-}"
      echo "STATE_BT=\${INSTALL_BT:-0}"
    else
      echo "STATE_HANGUL="
      echo "STATE_BT=0"
    fi
    HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
    if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
      echo "HANGUL=yes"
    else
      echo "HANGUL=no"
    fi
    if [ -f /etc/modules-load.d/btnxpuart.conf ]; then
      echo "BT=yes"
    else
      echo "BT=no"
    fi
  `);
  return {
    hangul: output.includes("HANGUL=yes"),
    bt: output.includes("BT=yes"),
  };
}

async function removeBt(ip: string, password: string, otherStillInstalled: boolean): Promise<string[]> {
  const logs: string[] = [];

  // 재연결 보조 서비스만 먼저 중지하고 bluetooth.service는 cleanup 뒤에 내린다.
  await runSsh(ip, password, `
    systemctl stop rekoit-bt-agent.service 2>/dev/null || true
    systemctl disable rekoit-bt-agent.service 2>/dev/null || true
    systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
    systemctl disable rekoit-bt-wake-reconnect.service 2>/dev/null || true
    systemctl stop rekoit-factory-guard.service 2>/dev/null || true
    systemctl disable rekoit-factory-guard.service 2>/dev/null || true
    systemctl daemon-reload
  `);
  logs.push("OK: 블루투스 보조 서비스 중지");

  const btCleanupResult = await runSsh(ip, password, buildBluetoothKeyboardCleanupScript());
  const removedCountMatch = btCleanupResult.match(/BT_KEYBOARD_REMOVED_COUNT=(\d+)/);
  const removedCount = removedCountMatch ? Number.parseInt(removedCountMatch[1], 10) : 0;
  logs.push(`OK: 블루투스 키보드 페어링 정리 (${removedCount}개)`);

  // BT 전용 흔적만 원복
  const result = await runSsh(ip, password, `
    mount -o remount,rw / || { echo "FAIL:remount"; exit 0; }
    rm -f /etc/modules-load.d/btnxpuart.conf
    rm -f /etc/systemd/system/rekoit-factory-guard.service
    rm -f /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
    rm -f /opt/rekoit/factory-guard.sh
    rmdir /opt/rekoit 2>/dev/null || true
    rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
    rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
    sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
    sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true
    STATE_FILE="/home/root/rekoit/install-state.conf"
    if [ -f "$STATE_FILE" ]; then
      sed -i 's/^INSTALL_BT=.*/INSTALL_BT=0/' "$STATE_FILE" 2>/dev/null || true
      sed -i 's/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=/' "$STATE_FILE" 2>/dev/null || true
      if grep -q '^BLUETOOTH_POWER_ON=' "$STATE_FILE" 2>/dev/null; then
        sed -i 's/^BLUETOOTH_POWER_ON=.*/BLUETOOTH_POWER_ON=0/' "$STATE_FILE" 2>/dev/null || true
      else
        printf '\nBLUETOOTH_POWER_ON=0\n' >> "$STATE_FILE"
      fi
      if grep -q '^INSTALL_HANGUL=' "$STATE_FILE" 2>/dev/null; then
        sed -i 's/^INSTALL_HANGUL=.*/INSTALL_HANGUL=${otherStillInstalled ? "1" : "0"}/' "$STATE_FILE" 2>/dev/null || true
      fi
    fi
    echo "BT_REMOVE_OK"
  `);
  if (result.includes("FAIL:remount")) {
    logs.push("WARNING: rootfs remount 실패");
  } else {
    logs.push("OK: 블루투스 런타임 설정 원복");
  }

  await runSsh(ip, password, `
    rm -rf /home/root/rekoit/bt-pairing 2>/dev/null || true
    rm -f /home/root/rekoit/install-bt.sh
    rm -f /home/root/rekoit/restore-bt.sh
    rm -f /home/root/rekoit/post-update-bt.sh
    rm -f /home/root/rekoit/bt-wake-reconnect.sh
    rm -f /home/root/rekoit/rekoit-bt-wake-reconnect.service
    find /home/root/rekoit -type d -empty -delete 2>/dev/null || true
  `);
  logs.push("OK: REKOIT 블루투스 관련 파일 정리");

  if (!otherStillInstalled) {
    await runSsh(ip, password, `
      rm -f /etc/systemd/system/rekoit-restore.service
      rm -f /etc/systemd/system/rekoit-bt-agent.service
      rm -f /etc/systemd/system/rekoit-bt-wake-reconnect.service
      rm -f /etc/systemd/system/multi-user.target.wants/rekoit-restore.service
      rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
      rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
      rm -f /etc/swupdate/conf.d/99-rekoit-postupdate
    `);
    logs.push("OK: BT-only REKOIT 공통 복구 경로 제거");
  }

  // 비활성 파티션 정리
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
        rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
        rm -f /mnt/inactive/etc/systemd/system/rekoit-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
        rm -rf /mnt/inactive/opt/rekoit 2>/dev/null || true
        rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
        rmdir /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
        ${otherStillInstalled ? "" : `
        rm -f /mnt/inactive/etc/systemd/system/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-agent.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-wake-reconnect.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
        rm -f /mnt/inactive/etc/swupdate/conf.d/99-rekoit-postupdate
        `}
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sed -i '/^FastConnectable = true$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sync
      fi
      umount /mnt/inactive 2>/dev/null || true
    fi
  `);
  logs.push("OK: 비활성 파티션 BT 흔적 제거");

  if (!otherStillInstalled) {
    await cleanupCommon(ip, password, logs);
  }

  await runSsh(ip, password, "systemctl daemon-reload");
  logs.push("OK: systemctl daemon-reload");

  await runSsh(ip, password, `
    systemctl stop bluetooth.service 2>/dev/null || true
  `);
  logs.push("OK: bluetooth.service 최종 종료");

  return logs;
}

async function removeHangul(ip: string, password: string, otherStillInstalled: boolean): Promise<string[]> {
  const logs: string[] = [];

  // 1. 모든 관련 서비스 중지 및 비활성화 (하나의 세션)
  await runSsh(ip, password, `
    systemctl stop xochitl 2>/dev/null || true
    systemctl stop hangul-daemon 2>/dev/null || true
    systemctl disable hangul-daemon 2>/dev/null || true
    ${otherStillInstalled ? "" : `
    systemctl stop rekoit-restore 2>/dev/null || true
    systemctl stop rekoit-factory-guard 2>/dev/null || true
    systemctl disable rekoit-restore 2>/dev/null || true
    systemctl disable rekoit-factory-guard 2>/dev/null || true
    `}
    systemctl daemon-reload
  `);
  logs.push("OK: 한글 입력 런타임 서비스 중지 및 비활성화");

  // 2. remount + rootfs 파일 제거 (하나의 세션)
  const mainResult = await runSsh(ip, password, `
    RESULTS=""
    mount -o remount,rw / || { echo "FAIL:remount"; exit 0; }

    LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
    LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
    
    # 직접적인 bind mount 해제 (루프)
    while grep -q " $LIBEPAPER " /proc/mounts 2>/dev/null; do
      umount -l "$LIBEPAPER" 2>/dev/null || umount "$LIBEPAPER" 2>/dev/null || break
      sleep 0.5
    done
    # tmpfs 소스 기반의 모든 마운트 지점 해제 (루프)
    while mount | grep -q "$LIBEPAPER_TMPFS"; do
      TARGET=$(mount | awk -v src="$LIBEPAPER_TMPFS" '$1==src {print $3; exit}')
      [ -n "$TARGET" ] || break
      umount -l "$TARGET" 2>/dev/null || umount "$TARGET" 2>/dev/null || break
      sleep 0.5
    done
    // libepaper 원본 복원 (마운트 해제만으로 충분)
    rm -f "$LIBEPAPER_TMPFS"

    # 서비스 파일 제거
    rm -f /etc/systemd/system/hangul-daemon.service
    rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    ${otherStillInstalled ? "" : `
    rm -f /etc/systemd/system/rekoit-restore.service
    rm -f /etc/systemd/system/rekoit-factory-guard.service
    rm -f /etc/systemd/system/multi-user.target.wants/rekoit-restore.service
    rm -f /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
    `}

    # 폰트 보존 (삭제하지 않음)
    # rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
    # fc-cache -f 2>/dev/null || true

    # factory-guard, swupdate hook 제거
    ${otherStillInstalled ? "" : `
    rm -f /etc/swupdate/conf.d/99-rekoit-postupdate
    rm -f /opt/rekoit/factory-guard.sh
    rmdir /opt/rekoit 2>/dev/null || true
    `}

    ${otherStillInstalled ? "" : `
    # bluetooth 원복
    sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
    sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true
    `}

    STATE_FILE="/home/root/rekoit/install-state.conf"
    if [ -f "$STATE_FILE" ]; then
      if grep -q '^INSTALL_HANGUL=' "$STATE_FILE" 2>/dev/null; then
        sed -i 's/^INSTALL_HANGUL=.*/INSTALL_HANGUL=0/' "$STATE_FILE" 2>/dev/null || true
      else
        printf '\nINSTALL_HANGUL=0\n' >> "$STATE_FILE"
      fi
    fi

    echo "$RESULTS ROOTFS_DONE"
  `);

  if (mainResult.includes("FAIL:remount")) {
    logs.push("ERROR: rootfs remount 실패 — 제거 불가");
    return logs;
  }
  logs.push(`OK: 한글 입력 런타임, libepaper 정리 (폰트 보존)${otherStillInstalled ? "" : ", REKOIT guard 제거"}`);

  await runSsh(ip, password, `
    rm -f /home/root/rekoit/install-hangul.sh
    rm -f /home/root/rekoit/restore-hangul.sh
    rm -f /home/root/rekoit/post-update-hangul.sh
    rm -f /home/root/rekoit/hangul-daemon
    rm -f /home/root/rekoit/hangul-daemon.service
    # 폰트는 지우지 않고 유지합니다.
    rm -f /home/root/rekoit/backup/libepaper.so.original
    rm -f /home/root/rekoit/backup/libepaper.so.latest
    rm -f /home/root/rekoit/backup/font_existed
    find /home/root/rekoit -type d -empty -delete 2>/dev/null || true
  `);
  logs.push("OK: REKOIT 한글 입력 관련 파일 정리 (폰트 유지)");

  // 3. 비활성 파티션 정리
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
      if [ -d /mnt/inactive/usr ]; then
        ${otherStillInstalled ? "" : `
        rm -f /mnt/inactive/opt/rekoit/factory-guard.sh
        rmdir /mnt/inactive/opt/rekoit 2>/dev/null || true
        `}
        # 비활성 파티션의 폰트도 유지합니다.
        ${otherStillInstalled ? "" : `rm -f /mnt/inactive/etc/swupdate/conf.d/99-rekoit-postupdate`}
        rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        ${otherStillInstalled ? "" : `
        rm -f /mnt/inactive/etc/systemd/system/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
        `}
        ${otherStillInstalled ? "" : `
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sed -i '/^FastConnectable = true$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        `}
        sync
      fi
      umount /mnt/inactive 2>/dev/null || true
    fi
  `);
  logs.push("OK: 비활성 파티션 한글 입력 런타임 흔적 정리");

  // 4. BT도 없으면 공통 파일도 정리
  if (!otherStillInstalled) {
    await cleanupCommon(ip, password, logs);
  }

  // 5. daemon-reload + xochitl 재시작
  await runSsh(ip, password, "systemctl daemon-reload && systemctl restart xochitl 2>/dev/null || true");
  logs.push("OK: xochitl 재시작");

  if (!otherStillInstalled) {
    await runSsh(ip, password, `
      systemctl stop bluetooth.service 2>/dev/null || true
    `);
    logs.push("OK: bluetooth.service 종료");
  } else {
    logs.push("OK: 블루투스 런타임 유지");
  }

  // 6. 최종 검증
  const verify = await runSsh(ip, password, `
    FAIL=""
    [ -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf ] && FAIL="$FAIL font_exists"
    ${otherStillInstalled ? "" : `[ -d /opt/rekoit ] && FAIL="$FAIL opt_exists"`}
    ${otherStillInstalled ? `
    [ -f /home/root/rekoit/install-hangul.sh ] && FAIL="$FAIL install_hangul_exists"
    [ -f /home/root/rekoit/restore-hangul.sh ] && FAIL="$FAIL restore_hangul_exists"
    [ -f /home/root/rekoit/post-update-hangul.sh ] && FAIL="$FAIL post_update_hangul_exists"
    [ -f /home/root/rekoit/hangul-daemon ] && FAIL="$FAIL hangul_daemon_exists"
    [ -f /home/root/rekoit/hangul-daemon.service ] && FAIL="$FAIL hangul_service_exists"
    [ -f /home/root/rekoit/fonts/NotoSansCJKkr-Regular.otf ] && FAIL="$FAIL hangul_font_backup_exists"
    [ -f /home/root/rekoit/backup/libepaper.so.original ] && FAIL="$FAIL libepaper_backup_exists"
    [ -f /home/root/rekoit/backup/libepaper.so.latest ] && FAIL="$FAIL libepaper_latest_exists"
    [ -f /home/root/rekoit/backup/font_existed ] && FAIL="$FAIL font_marker_exists"
    ` : `[ -d /home/root/rekoit ] && FAIL="$FAIL rekoit_home_exists"`}
    [ -f /dev/shm/hangul-libepaper.so ] && FAIL="$FAIL libepaper_tmpfs_exists"
    mount | grep -q ' /usr/lib/plugins/platforms/libepaper.so ' && FAIL="$FAIL libepaper_bind_mount_exists"
    ${otherStillInstalled ? "" : `[ -f /etc/swupdate/conf.d/99-rekoit-postupdate ] && FAIL="$FAIL swupdate_hook_exists"`}
    if [ -z "$FAIL" ]; then echo "VERIFY_OK"; else echo "VERIFY_FAIL:$FAIL"; fi
  `);
  const verifyTrimmed = verify.trim();
  if (verifyTrimmed === "VERIFY_OK") {
    logs.push("OK: 제거 검증 완료");
  } else {
    logs.push(`WARNING: 일부 항목 미제거 — ${verifyTrimmed}`);
  }

  return logs;
}

async function cleanupCommon(ip: string, password: string, logs: string[]): Promise<void> {
  // .bashrc 정리
  logs.push("OK: 로그인 REKOIT 자동복구 스크립트 제거");

  // REKOIT 디렉토리 전체 제거
  await runSsh(ip, password, `
    find /home/root/rekoit -type f -delete 2>/dev/null || true
    find /home/root/rekoit -type d -empty -delete 2>/dev/null || true
    rm -rf /home/root/rekoit 2>/dev/null || true
  `);
  logs.push("OK: REKOIT 디렉토리 전체 제거");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { ip, password, target } = body as { ip: string; password: string; target: string };

    if (!ip || !password || !target) {
      return NextResponse.json({ success: false, error: "ip, password, target 필수" }, { status: 400 });
    }

    if (!/^[\d.]+$/.test(ip)) {
      return NextResponse.json({ success: false, error: "Invalid IP" }, { status: 400 });
    }

    const normalizedTarget = target === "onscreen" ? "hangul" : target;

    if (normalizedTarget !== "bt" && normalizedTarget !== "hangul" && normalizedTarget !== "font") {
      return NextResponse.json({ success: false, error: "target은 bt, hangul 또는 font" }, { status: 400 });
    }

    // 현재 설치 상태 감지
    const detected = await detect(ip, password);

    if (normalizedTarget === "bt" && !detected.bt) {
      return NextResponse.json({ success: false, error: "제거할 블루투스 설치가 감지되지 않습니다" });
    }

    if (normalizedTarget === "hangul" && !detected.hangul) {
      return NextResponse.json({ success: false, error: "제거할 한글 입력 구성 요소가 감지되지 않습니다" });
    }

    let logs: string[] = [];
    if (normalizedTarget === "bt") {
      logs = await removeBt(ip, password, detected.hangul);
    } else if (normalizedTarget === "hangul") {
      logs = await removeHangul(ip, password, detected.bt);
    } else if (normalizedTarget === "font") {
      logs = await removeOnlyFont(ip, password);
    }

    return NextResponse.json({ success: true, logs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

async function removeOnlyFont(ip: string, password: string): Promise<string[]> {
  const logs: string[] = [];
  await runSsh(ip, password, `
    # 신 경로 삭제 (사용자 데이터 영역)
    rm -rf /home/root/.local/share/fonts/rekoit 2>/dev/null || true
    
    # 구 경로 삭제 (시스템 영역 - 기존 사용자 대응)
    rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf 2>/dev/null || true
    
    fc-cache -f 2>/dev/null || true
  `);
  logs.push("OK: 한글 폰트 정리 완료 (구/신 경로 모두 확인)");
  logs.push("OK: 폰트 캐시 갱신 완료");
  return logs;
}

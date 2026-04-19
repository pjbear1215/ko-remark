export function sanitizeBluetoothLine(line) {
  return line
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

export function extractDisplayedPasskey(line) {
  const stripped = sanitizeBluetoothLine(line);
  const patterns = [
    /Passkey:\s*(\d{6})/i,
    /Confirm passkey\s*:?\s*(\d{6})/i,
    /Request confirmation\s*:?\s*(\d{6})/i,
    /Enter PIN code:\s*(\d{6})/i,
    /PIN code:\s*(\d{6})/i,
    /Enter passkey:\s*(\d{6})/i,
    /passkey\s+(\d{6})/i,
  ];

  for (const pattern of patterns) {
    const match = stripped.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

export function classifyPairingFailure(line, { passkeySent = false } = {}) {
  const stripped = sanitizeBluetoothLine(line);

  if (!stripped) {
    return null;
  }

  if (stripped.includes("InProgress")) {
    return passkeySent ? "ignore" : "retry";
  }

  if (
    (stripped.includes("Failed to pair") && !stripped.includes("InProgress")) ||
    stripped.includes("Authentication Failed") ||
    stripped.includes("Authentication Rejected") ||
    stripped.includes("Paired: no")
  ) {
    return "fail";
  }

  return null;
}

export function buildBluetoothCleanupScript() {
  return `
# Ensure no background bluetoothctl is running
bluetoothctl scan off 2>/dev/null || true
bluetoothctl pairable off 2>/dev/null || true
bluetoothctl agent off 2>/dev/null || true
killall -9 bluetoothctl 2>/dev/null || true
sleep 0.5
`;
}

export function buildStaleDeviceRemovalScript({ address }) {
  const escapedAddress = address.replace(/"/g, '\\"');
  return `
bluetoothctl disconnect ${escapedAddress} 2>/dev/null || true
bluetoothctl untrust ${escapedAddress} 2>/dev/null || true
bluetoothctl remove ${escapedAddress} 2>/dev/null || true
rm -rf /var/lib/bluetooth/*/${escapedAddress} 2>/dev/null || true
`;
}

export function buildBluetoothPairSessionScript({ address, name, scanTimeout = 15 }) {
  const escapedAddress = address.replace(/"/g, '\\"');
  const escapedName = (name ?? "").replace(/"/g, '\\"');

  return `
# Use lowercase for consistency as BlueZ scan usually returns lowercase
ADDR=$(echo "${escapedAddress}" | tr '[:upper:]' '[:lower:]')
DEVICE_NAME="${escapedName}"

log() { echo "LOG|$1"; }

log "--- 페어링 절차 시작 (대상: $DEVICE_NAME / $ADDR) ---"

# 1. STOP INTERFERING SERVICES
log "백그라운드 서비스 및 기존 세션 정리..."
systemctl stop rekoit-bt-wake-reconnect.service 2>/dev/null || true
killall -9 bluetoothctl 2>/dev/null || true
# Create sentinel to block background reconnection monitor
touch /tmp/rekoit-setup-active
sleep 0.5

# 2. CLEAN UP OLD INFO
log "기존 기기 정보 캐시 삭제 중..."
bluetoothctl disconnect "$ADDR" 2>/dev/null || true
bluetoothctl untrust "$ADDR" 2>/dev/null || true
bluetoothctl remove "$ADDR" 2>/dev/null || true
rm -rf /var/lib/bluetooth/*/"$ADDR" 2>/dev/null || true

if [ -n "$DEVICE_NAME" ]; then
  bluetoothctl devices 2>/dev/null | while read -r _ STALE_ADDR STALE_NAME; do
    [ -n "$STALE_ADDR" ] || continue
    [ "$STALE_NAME" = "$DEVICE_NAME" ] || continue
    log "중복된 이름의 기기 정리: $STALE_ADDR"
    bluetoothctl disconnect "$STALE_ADDR" 2>/dev/null || true
    bluetoothctl untrust "$STALE_ADDR" 2>/dev/null || true
    bluetoothctl remove "$STALE_ADDR" 2>/dev/null || true
    rm -rf /var/lib/bluetooth/*/"$STALE_ADDR" 2>/dev/null || true
  done
fi
sleep 1

# 3. INTERACTIVE SESSION SETUP
IN_FIFO="/tmp/bluetoothctl-in.$$"
OUT_LOG="/tmp/bluetoothctl-out.$$"
rm -f "$IN_FIFO" "$OUT_LOG"
mkfifo "$IN_FIFO"
: > "$OUT_LOG"
exec 3<>"$IN_FIFO"

cleanup() {
  exec 3>&- 2>/dev/null || true
  kill "$TAIL_PID" 2>/dev/null || true
  kill "$AUTO_YES_PID" 2>/dev/null || true
  kill "$BT_PID" 2>/dev/null || true
  rm -f "$IN_FIFO" "$OUT_LOG" /tmp/rekoit-setup-active
  log "백그라운드 서비스 복구 중..."
  systemctl start rekoit-bt-wake-reconnect.service 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "인터랙티브 블루투스 에이전트 구동..."
bluetoothctl < "$IN_FIFO" > "$OUT_LOG" 2>&1 &
BT_PID=$!
tail -n +1 -f "$OUT_LOG" &
TAIL_PID=$!

# Auto-confirm helper for yes/no prompts
(
  tail -f "$OUT_LOG" | while read -r LINE; do
    case "$LINE" in
      *"[yes/no]"*|*"Confirm passkey"*|*"Accept pairing"*|*"Authorize service"*)
        printf 'yes\\n' >&3
        echo "LOG|AUTO_CONFIRM: Sent 'yes' to prompt"
        ;;
    esac
  done
) &
AUTO_YES_PID=$!

send_cmd() {
  printf '%s\\n' "$1" >&3
  echo "CMD> $1"
}

echo "INTERACTIVE_START"
sleep 0.5
send_cmd "agent KeyboardOnly"
sleep 0.2
send_cmd "default-agent"
sleep 0.2
send_cmd "power on"
sleep 0.2
send_cmd "pairable on"
sleep 0.5

log "기기 검색 및 페어링 요청 전송..."
# Start scan to find the BLE device, then pair immediately
send_cmd "scan on"
sleep 2
send_cmd "pair $ADDR"

PAIRED=0
COUNT=0
log "페어링 응답 대기 중 (최대 60초)..."
while [ $COUNT -lt 60 ]; do
  COUNT=$((COUNT + 1))
  sleep 1
  INFO=$(bluetoothctl info "$ADDR" 2>&1)
  
  # Status log for debugging
  IS_CONNECTED=$(echo "$INFO" | grep -q "Connected: yes" && echo "YES" || echo "NO")
  IS_PAIRED=$(echo "$INFO" | grep -q "Paired: yes" && echo "YES" || echo "NO")
  echo "DEBUG_STATE [$COUNT/60]: Connected=$IS_CONNECTED, Paired=$IS_PAIRED"

  case "$INFO" in
    *"Paired: yes"*)
      PAIRED=1
      break
      ;;
  esac
done

if [ "$PAIRED" -eq 1 ]; then
  log "페어링 성공! 기기 신뢰 및 연결 설정 중..."
  send_cmd "scan off"
  sleep 0.2
  send_cmd "trust $ADDR"
  sleep 1
  send_cmd "connect $ADDR"
  
  READY=0
  COUNT=0
  while [ $COUNT -lt 15 ]; do
    COUNT=$((COUNT + 1))
    sleep 1
    INFO=$(bluetoothctl info "$ADDR" 2>&1)
    if echo "$INFO" | grep -q "Connected: yes"; then
      READY=1
      break
    fi
  done
  
  if [ "$READY" -eq 1 ]; then
    echo "PAIRED_ADDR:$ADDR"
    echo "PAIR_SUCCESS"
  else
    log "경고: 페어링은 성공했으나 연결이 불안정합니다."
    echo "PAIRED_ADDR:$ADDR"
    echo "PAIR_PARTIAL"
  fi
else
  log "오류: 페어링 요청이 기기에 의해 거절되었거나 패스키 입력이 누락되었습니다."
  echo "PAIR_FAILED"
fi

send_cmd "quit"
wait "$BT_PID"
BT_STATUS=$?
log "세션 종료 (Status: $BT_STATUS)"
`;
}

export function parseBluetoothInfoStatus(output) {
  const text = output ?? "";
  return {
    paired: text.includes("Paired: yes"),
    bonded: text.includes("Bonded: yes"),
    trusted: text.includes("Trusted: yes"),
    connected: text.includes("Connected: yes"),
  };
}

export function isBluetoothReadyStatus(status) {
  return Boolean(status?.paired && status?.trusted && status?.connected);
}

export function shouldTreatPairingAttemptAsSuccess(status) {
  return isBluetoothReadyStatus(status);
}

export function classifyBluetoothJournalIssue(output) {
  const text = output ?? "";
  if (text.includes("input-hog profile accept failed")) {
    return "hog_accept_failed";
  }
  return null;
}

export function extractLatestMatchingDeviceAddress(output, name) {
  const text = output ?? "";
  const targetName = (name ?? "").trim();
  if (!targetName) return null;

  let latest = null;
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(?:\[NEW\]\s+)?Device\s+([0-9A-F:]+)\s+(.+)$/i);
    if (!match) continue;
    if (match[2].trim() === targetName) {
      latest = match[1];
    }
  }

  return latest;
}

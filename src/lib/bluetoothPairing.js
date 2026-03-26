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
bluetoothctl scan off 2>/dev/null || true
bluetoothctl pairable off 2>/dev/null || true
bluetoothctl agent off 2>/dev/null || true
killall bluetoothctl 2>/dev/null || true
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

export function buildBluetoothPairSessionScript({ address, name }) {
  const escapedAddress = address.replace(/"/g, '\\"');
  const escapedName = (name ?? "").replace(/"/g, '\\"');

  return `
ADDR="${escapedAddress}"
DEVICE_NAME="${escapedName}"

${buildStaleDeviceRemovalScript({ address, name })}

if [ -n "$DEVICE_NAME" ]; then
  bluetoothctl devices 2>/dev/null | while read -r _ STALE_ADDR STALE_NAME; do
    [ -n "$STALE_ADDR" ] || continue
    [ "$STALE_NAME" = "$DEVICE_NAME" ] || continue
    bluetoothctl disconnect "$STALE_ADDR" 2>/dev/null || true
    bluetoothctl untrust "$STALE_ADDR" 2>/dev/null || true
    bluetoothctl remove "$STALE_ADDR" 2>/dev/null || true
    rm -rf /var/lib/bluetooth/*/"$STALE_ADDR" 2>/dev/null || true
  done
fi

echo "SCANNING..."
bluetoothctl power on 2>/dev/null || true
bluetoothctl pairable on 2>/dev/null || true
INFO=$(bluetoothctl info "$ADDR" 2>&1)
FOUND=0
case "$INFO" in
  *Name:*|*RSSI:*)
    FOUND=1
    ;;
esac
if [ "$FOUND" -eq 0 ]; then
  SCAN_OUT=$(bluetoothctl --timeout 6 scan on 2>&1)
  echo "$SCAN_OUT"
  OBSERVED_ADDRS=$(printf '%s\n' "$SCAN_OUT" | awk '/Device [0-9A-F:]+/ {print $3}' | sort -u)
  if [ -n "$DEVICE_NAME" ] && [ -n "$OBSERVED_ADDRS" ]; then
    for CANDIDATE_ADDR in $OBSERVED_ADDRS; do
      CANDIDATE_INFO=$(bluetoothctl info "$CANDIDATE_ADDR" 2>&1)
      CANDIDATE_NAME=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
      CANDIDATE_ALIAS=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1)
      if [ "$CANDIDATE_NAME" = "$DEVICE_NAME" ] || [ "$CANDIDATE_ALIAS" = "$DEVICE_NAME" ]; then
        ADDR="$CANDIDATE_ADDR"
        FOUND=1
        break
      fi
    done
  fi
fi
if [ "$FOUND" -eq 0 ]; then
  echo "DEVICE_NOT_FOUND: $ADDR"
  exit 1
fi

IN_FIFO="/tmp/bluetoothctl-in.$$"
OUT_LOG="/tmp/bluetoothctl-out.$$"
rm -f "$IN_FIFO" "$OUT_LOG"
mkfifo "$IN_FIFO"
: > "$OUT_LOG"
exec 3<>"$IN_FIFO"

cleanup() {
  exec 3>&- 2>/dev/null || true
  kill "$TAIL_PID" 2>/dev/null || true
  kill "$BT_PID" 2>/dev/null || true
  rm -f "$IN_FIFO" "$OUT_LOG"
}
trap cleanup EXIT INT TERM

bluetoothctl < "$IN_FIFO" > "$OUT_LOG" 2>&1 &
BT_PID=$!
tail -n +1 -f "$OUT_LOG" &
TAIL_PID=$!

send_cmd() {
  printf '%s\\n' "$1" >&3
  echo "CMD> $1"
}

echo "INTERACTIVE_START"
sleep 0.2
send_cmd "pairable on"
sleep 0.2
send_cmd "agent off"
sleep 0.2
send_cmd "agent KeyboardDisplay"
sleep 0.2
send_cmd "default-agent"
sleep 0.2
send_cmd "disconnect $ADDR"
sleep 0.2
send_cmd "untrust $ADDR"
sleep 0.3
send_cmd "pair $ADDR"

PAIRED=0
COUNT=0
while [ $COUNT -lt 30 ]; do
  COUNT=$((COUNT + 1))
  sleep 1
  INFO=$(bluetoothctl info "$ADDR" 2>&1)
  case "$INFO" in
    *"Paired: yes"*)
      PAIRED=1
      break
      ;;
  esac
done

if [ "$PAIRED" -eq 1 ]; then
  send_cmd "trust $ADDR"
  sleep 1.5
  send_cmd "connect $ADDR"
  READY=0
  COUNT=0
  while [ $COUNT -lt 15 ]; do
    COUNT=$((COUNT + 1))
    sleep 1
    INFO=$(bluetoothctl info "$ADDR" 2>&1)
    case "$INFO" in
      *"Paired: yes"*"Trusted: yes"*"Connected: yes"*|*"Paired: yes"*"Connected: yes"*"Trusted: yes"*|*"Trusted: yes"*"Paired: yes"*"Connected: yes"*|*"Trusted: yes"*"Connected: yes"*"Paired: yes"*|*"Connected: yes"*"Paired: yes"*"Trusted: yes"*|*"Connected: yes"*"Trusted: yes"*"Paired: yes"*)
        READY=1
        break
        ;;
    esac
  done
  if [ "$READY" -eq 1 ]; then
    echo "PAIRED_ADDR:$ADDR"
    echo "PAIR_SUCCESS"
  else
    echo "PAIRED_ADDR:$ADDR"
    echo "PAIR_PARTIAL"
  fi
else
  echo "PAIR_FAILED"
fi

send_cmd "quit"
wait "$BT_PID"
BT_STATUS=$?
echo "PAIR_PROC_CLOSED: $BT_STATUS"
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

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBluetoothCleanupScript,
  buildBluetoothPairSessionScript,
  buildStaleDeviceRemovalScript,
  classifyBluetoothJournalIssue,
  extractLatestMatchingDeviceAddress,
  isBluetoothReadyStatus,
  parseBluetoothInfoStatus,
  shouldTreatPairingAttemptAsSuccess,
  sanitizeBluetoothLine,
  extractDisplayedPasskey,
  classifyPairingFailure,
} from "./bluetoothPairing.js";

test("extractDisplayedPasskey reads classic Passkey output", () => {
  assert.equal(
    extractDisplayedPasskey("Passkey: 123456"),
    "123456",
  );
});

test("extractDisplayedPasskey reads confirm passkey output", () => {
  assert.equal(
    extractDisplayedPasskey("[agent] Confirm passkey 654321 (yes/no)"),
    "654321",
  );
});

test("extractDisplayedPasskey reads enter pin code output", () => {
  assert.equal(
    extractDisplayedPasskey("[agent] Enter PIN code: 012345"),
    "012345",
  );
});

test("extractDisplayedPasskey reads request confirmation output", () => {
  assert.equal(
    extractDisplayedPasskey("[agent] Request confirmation 222333"),
    "222333",
  );
});

test("sanitizeBluetoothLine removes ansi escapes and carriage returns", () => {
  assert.equal(
    sanitizeBluetoothLine(
      "\u001b[0;94m[bluetooth]\u001b[0m# \r[agent] Confirm passkey 111222 (yes/no)\r",
    ),
    "[bluetooth]# [agent] Confirm passkey 111222 (yes/no)",
  );
});

test("classifyPairingFailure retries in-progress when no passkey was shown yet", () => {
  assert.equal(
    classifyPairingFailure("Failed to pair: org.bluez.Error.InProgress", {
      passkeySent: false,
    }),
    "retry",
  );
});

test("classifyPairingFailure ignores in-progress after passkey prompt", () => {
  assert.equal(
    classifyPairingFailure("Failed to pair: org.bluez.Error.InProgress", {
      passkeySent: true,
    }),
    "ignore",
  );
});

test("classifyPairingFailure fails on authentication rejection", () => {
  assert.equal(
    classifyPairingFailure("Authentication Rejected"),
    "fail",
  );
});

test("buildBluetoothCleanupScript powers pairable off and kills bluetoothctl", () => {
  const script = buildBluetoothCleanupScript();
  assert.match(script, /scan off/);
  assert.match(script, /pairable off/);
  assert.match(script, /agent off/);
  assert.match(script, /killall bluetoothctl/);
});

test("buildStaleDeviceRemovalScript fully clears the selected address for a fresh pair", () => {
  const script = buildStaleDeviceRemovalScript({
    address: "D6:A6:54:68:75:8B",
    name: "Keys-To-Go 2",
  });

  assert.match(script, /disconnect D6:A6:54:68:75:8B/);
  assert.match(script, /untrust D6:A6:54:68:75:8B/);
  assert.match(script, /remove D6:A6:54:68:75:8B/);
  assert.match(script, /rm -rf \/var\/lib\/bluetooth\/\*\/D6:A6:54:68:75:8B/);
  assert.doesNotMatch(script, /systemctl restart bluetooth/);
  assert.doesNotMatch(script, /STALE_ADDR/);
});

test("buildBluetoothPairSessionScript runs bluetoothctl via fifo and pairs the selected address", () => {
  const script = buildBluetoothPairSessionScript({
    address: "D6:A6:54:68:75:8C",
    name: "Keys-To-Go 2",
  });

  assert.match(script, /mkfifo/);
  assert.match(script, /exec 3<>/);
  assert.match(script, /bluetoothctl --timeout 6 scan on/);
  assert.match(script, /DEVICE_NAME="Keys-To-Go 2"/);
  assert.match(script, /bluetoothctl devices 2>\/dev\/null \| while read -r _ STALE_ADDR STALE_NAME/);
  assert.match(script, /send_cmd "pair \$ADDR"/);
  assert.match(script, /echo "PAIRED_ADDR:\$ADDR"/);
  assert.match(script, /echo "PAIR_SUCCESS"/);
  assert.match(script, /echo "PAIR_FAILED"/);
  assert.match(script, /send_cmd "trust \$ADDR"/);
  assert.match(script, /send_cmd "connect \$ADDR"/);
  assert.match(script, /INTERACTIVE_START/);
  assert.doesNotMatch(script, /sleep 45/);
  assert.match(script, /agent KeyboardDisplay/);
  assert.match(script, /INFO=\$\(bluetoothctl info "\$ADDR" 2>&1\)/);
  assert.match(script, /OBSERVED_ADDRS/);
  assert.match(script, /Alias:/);
  assert.match(script, /Name:/);
  assert.match(script, /for CANDIDATE_ADDR in \$OBSERVED_ADDRS/);
});

test("buildBluetoothPairSessionScript tries cached address before fallback scan", () => {
  const script = buildBluetoothPairSessionScript({
    address: "D6:A6:54:68:75:8C",
    name: "Keys-To-Go 2",
  });

  const candidateLoopIndex = script.indexOf('for CANDIDATE_ADDR in $OBSERVED_ADDRS; do');
  const cachedInfoIndex = script.indexOf('INFO=$(bluetoothctl info "$ADDR" 2>&1)');

  assert.notEqual(candidateLoopIndex, -1);
  assert.notEqual(cachedInfoIndex, -1);
  assert.ok(
    cachedInfoIndex < candidateLoopIndex,
    "cached bluetoothctl info should be checked before fallback scan",
  );
});

test("parseBluetoothInfoStatus reads paired trusted connected state", () => {
  const status = parseBluetoothInfoStatus(`
Device D6:A6:54:68:75:8C (random)
  Paired: yes
  Bonded: yes
  Trusted: no
  Connected: yes
`);

  assert.equal(status.paired, true);
  assert.equal(status.bonded, true);
  assert.equal(status.trusted, false);
  assert.equal(status.connected, true);
});

test("isBluetoothReadyStatus requires connected state as well", () => {
  assert.equal(
    isBluetoothReadyStatus({
      paired: true,
      bonded: true,
      trusted: true,
      connected: true,
    }),
    true,
  );
});

test("isBluetoothReadyStatus returns false when trust is missing", () => {
  assert.equal(
    isBluetoothReadyStatus({
      paired: true,
      bonded: true,
      trusted: false,
      connected: true,
    }),
    false,
  );
});

test("shouldTreatPairingAttemptAsSuccess requires a trusted connected paired device", () => {
  assert.equal(
    shouldTreatPairingAttemptAsSuccess({
      paired: true,
      bonded: true,
      trusted: false,
      connected: false,
    }),
    false,
  );

  assert.equal(
    shouldTreatPairingAttemptAsSuccess({
      paired: true,
      bonded: true,
      trusted: true,
      connected: true,
    }),
    true,
  );
});

test("classifyBluetoothJournalIssue detects input-hog accept failure", () => {
  const issue = classifyBluetoothJournalIssue(
    "service_accept() input-hog profile accept failed for D6:A6:54:68:75:8D",
  );

  assert.equal(issue, "hog_accept_failed");
});

test("extractLatestMatchingDeviceAddress returns the newest address for the same device name", () => {
  const address = extractLatestMatchingDeviceAddress(`
Device D6:A6:54:68:75:8C Keys-To-Go 2
Device D6:A6:54:68:75:8D Keys-To-Go 2
Device 11:22:33:44:55:66 Other Keyboard
`, "Keys-To-Go 2");

  assert.equal(address, "D6:A6:54:68:75:8D");
});

test("extractLatestMatchingDeviceAddress also parses NEW scan output lines", () => {
  const address = extractLatestMatchingDeviceAddress(`
[NEW] Device D6:A6:54:68:75:8C Keys-To-Go 2
[NEW] Device D6:A6:54:68:75:8D Keys-To-Go 2
`, "Keys-To-Go 2");

  assert.equal(address, "D6:A6:54:68:75:8D");
});

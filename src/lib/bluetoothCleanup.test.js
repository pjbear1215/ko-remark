import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBluetoothKeyboardCleanupScript,
  isKeyboardBluetoothInfo,
} from "./bluetoothCleanup.js";

test("isKeyboardBluetoothInfo detects keyboard devices by icon", () => {
  assert.equal(
    isKeyboardBluetoothInfo("Icon: input-keyboard"),
    true,
  );
});

test("isKeyboardBluetoothInfo detects keyboard devices by HID uuid", () => {
  assert.equal(
    isKeyboardBluetoothInfo("UUID: Human Interface Device    (00001812-0000-1000-8000-00805f9b34fb)"),
    true,
  );
});

test("isKeyboardBluetoothInfo ignores non-keyboard devices", () => {
  assert.equal(
    isKeyboardBluetoothInfo("Icon: audio-card"),
    false,
  );
});

test("buildBluetoothKeyboardCleanupScript removes paired keyboard records without restarting bluetooth", () => {
  const script = buildBluetoothKeyboardCleanupScript();

  assert.match(script, /find \/var\/lib\/bluetooth/);
  assert.match(script, /disconnect "\$ADDR"/);
  assert.match(script, /untrust "\$ADDR"/);
  assert.match(script, /remove "\$ADDR"/);
  assert.match(script, /\/var\/lib\/bluetooth/);
  assert.match(script, /cache\/\$ADDR/);
  assert.doesNotMatch(script, /systemctl restart bluetooth/);
  assert.match(script, /BT_KEYBOARD_REMOVED_COUNT=/);
});

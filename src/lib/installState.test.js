import test from "node:test";
import assert from "node:assert/strict";

import {
  XOCHITL_DROPIN_DIR,
  renderInstallState,
} from "./installState.js";

test("renderInstallState writes shell-safe persisted flags", () => {
  assert.equal(
    renderInstallState({
      installHangul: false,
      installBt: true,
      swapLeftCtrlCapsLock: true,
      btDeviceAddress: "EF:CE:E6:51:BF:1C",
    }),
    "INSTALL_HANGUL=0\nINSTALL_BT=1\nBLUETOOTH_POWER_ON=0\nSWAP_LEFT_CTRL_CAPSLOCK=1\nBT_DEVICE_ADDRESS=EF:CE:E6:51:BF:1C\nKEYBOARD_LOCALES=\n",
  );
});

test("xochitl drop-in uses the vendor unit directory", () => {
  assert.equal(
    XOCHITL_DROPIN_DIR,
    "/usr/lib/systemd/system/xochitl.service.d",
  );
});

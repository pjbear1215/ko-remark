import test from "node:test";
import assert from "node:assert/strict";

import {
  XOCHITL_DROPIN_DIR,
  renderInstallState,
} from "./installState.js";

test("renderInstallState writes shell-safe persisted flags", () => {
  assert.equal(
    renderInstallState({
      installBt: true,
    }),
    "INSTALL_KEYPAD=0\nINSTALL_BT=1\nKEYBOARD_LOCALES=\n",
  );
});

test("xochitl drop-in uses the vendor unit directory", () => {
  assert.equal(
    XOCHITL_DROPIN_DIR,
    "/usr/lib/systemd/system/xochitl.service.d",
  );
});

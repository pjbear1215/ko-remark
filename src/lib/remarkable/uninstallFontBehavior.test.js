import test from "node:test";
import assert from "node:assert/strict";

import {
  HANGUL_FONT_PATH,
  buildFontRemovalCommands,
} from "./uninstallFontBehavior.js";

test("buildFontRemovalCommands preserves font when deleteFont is false", () => {
  assert.equal(
    buildFontRemovalCommands({ deleteFont: false }),
    "# 폰트 유지",
  );
});

test("buildFontRemovalCommands removes the runtime font and refreshes cache when requested", () => {
  const script = buildFontRemovalCommands({
    deleteFont: true,
    ignoreMissing: true,
    refreshCache: true,
  });

  assert.match(script, new RegExp(`rm -f ${HANGUL_FONT_PATH.replace(/\//g, "\\/")}`));
  assert.match(script, /2>\/dev\/null \|\| true/);
  assert.match(script, /fc-cache -f/);
});

test("buildFontRemovalCommands supports mounted root prefixes", () => {
  const script = buildFontRemovalCommands({
    deleteFont: true,
    prefix: "/mnt/direct_rootfs",
  });

  assert.match(script, /rm -f \/mnt\/direct_rootfs\/usr\/share\/fonts\/ttf\/noto\/NotoSansCJKkr-Regular\.otf/);
  assert.doesNotMatch(script, /fc-cache -f/);
});

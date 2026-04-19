#!/usr/bin/env node

const net = require("net");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

const url = process.argv[2] || "http://localhost:3000";
const delayMs = Number(process.argv[3] || 500);
const maxAttempts = Number(process.argv[4] || 60);

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function commandExists(path) {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  try {
    return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function trySpawn(command, args) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openBrowser(targetUrl) {
  if (process.platform === "darwin") {
    trySpawn("open", [targetUrl]);
    return;
  }

  if (isWsl()) {
    if (commandAvailable("wslview") && trySpawn("wslview", [targetUrl])) {
      return;
    }
    if (commandExists("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")) {
      trySpawn("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
        "-NoProfile",
        "-Command",
        `Start-Process '${targetUrl}'`,
      ]);
      return;
    }
  }

  if (process.platform === "linux" && commandAvailable("xdg-open")) {
    trySpawn("xdg-open", [targetUrl]);
  }
}

function waitForServer(targetUrl, attemptsLeft, onReady) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  let settled = false;

  const retry = () => {
    if (settled) return;
    settled = true;
    if (attemptsLeft <= 1) {
      onReady();
      return;
    }
    setTimeout(() => {
      waitForServer(targetUrl, attemptsLeft - 1, onReady);
    }, 1000);
  };

  const socket = net.connect({ host: hostname, port });
  socket.setTimeout(1000);

  socket.on("connect", () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    onReady();
  });

  socket.on("timeout", () => {
    socket.destroy();
    retry();
  });

  socket.on("error", () => {
    socket.destroy();
    retry();
  });
}

setTimeout(() => {
  waitForServer(url, maxAttempts, () => {
    openBrowser(url);
  });
}, delayMs);

#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require("child_process");
const { exec } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = path.resolve(__dirname, "..");

/**
 * Check if a given port is available on 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find an available port starting from the preferred port.
 * @param {number} preferred
 * @returns {Promise<number>}
 */
async function findAvailablePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${preferred}-${preferred + 99}`,
  );
}

/**
 * Open the default browser on macOS or Linux.
 * @param {string} url
 */
function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${command} "${url}"`, (error) => {
    if (error) {
      console.log(`\nBrowser could not be opened automatically.`);
      console.log(`Please open: ${url}`);
    }
  });
}

/**
 * Run `npx next build` if the .next directory does not exist.
 * @returns {Promise<void>}
 */
function ensureBuild() {
  const nextDir = path.join(PROJECT_DIR, ".next");
  if (fs.existsSync(nextDir)) {
    return Promise.resolve();
  }

  console.log("Building the application (first run)...\n");

  return new Promise((resolve, reject) => {
    const buildProc = spawn("npx", ["next", "build"], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
      shell: true,
    });

    buildProc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build failed with exit code ${code}`));
      }
    });

    buildProc.on("error", (err) => {
      reject(new Error(`Build process error: ${err.message}`));
    });
  });
}

/** @type {import("child_process").ChildProcess | null} */
let serverProc = null;

function shutdown() {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  try {
    await ensureBuild();

    const port = await findAvailablePort(3000);
    const url = `http://127.0.0.1:${port}`;

    console.log("reMarkable 한글 설치 가이드를 시작합니다...");
    console.log(url);
    console.log("\nCtrl+C to stop.\n");

    serverProc = spawn(
      "npx",
      ["next", "start", "-p", String(port), "-H", "127.0.0.1"],
      {
        cwd: PROJECT_DIR,
        stdio: "inherit",
        shell: true,
      },
    );

    serverProc.on("error", (err) => {
      console.error(`Server error: ${err.message}`);
      process.exit(1);
    });

    serverProc.on("close", (code) => {
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}`);
        process.exit(code);
      }
    });

    // Wait briefly for the server to start, then open the browser
    setTimeout(() => {
      openBrowser(url);
    }, 2000);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

main();

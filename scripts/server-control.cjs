const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const pidFile = path.join(rootDir, ".server.pid");
const outLog = path.join(rootDir, "server-live.log");
const errLog = path.join(rootDir, "server-live.err.log");
const serverEntry = path.join(rootDir, "apps", "server", "dist", "index.js");
const serverPort = 4318;

function isAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const raw = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function clearPidFile() {
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

function writePid(pid) {
  fs.writeFileSync(pidFile, String(pid), "utf8");
}

function findListeningPids(port) {
  try {
    const output = execFileSync("cmd.exe", ["/c", "netstat -ano -p tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });

    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) {
        continue;
      }

      const [proto, localAddress, foreignAddress, state, pidText] = parts;
      if (proto !== "TCP" || state !== "LISTENING") {
        continue;
      }

      if (!localAddress.endsWith(`:${port}`)) {
        continue;
      }

      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }

    return [...pids];
  } catch {
    return [];
  }
}

function killPid(pid) {
  if (!pid || !isAlive(pid)) {
    return Promise.resolve(true);
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "inherit",
        windowsHide: true,
      });

      killer.on("exit", (code) => resolve(code === 0));
    });
  }

  try {
    process.kill(pid, "SIGTERM");
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

async function stopListenersOnPort(port) {
  const listeners = findListeningPids(port);
  if (listeners.length === 0) {
    return true;
  }

  let allStopped = true;
  for (const pid of listeners) {
    const stopped = await killPid(pid);
    allStopped = stopped && allStopped;
    if (stopped) {
      console.log(`Stopped server pid ${pid}.`);
    } else {
      console.error(`Failed to stop server pid ${pid}.`);
    }
  }

  return allStopped;
}

async function ensurePortFree(port) {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    await killPid(pid);
    clearPidFile();
  }

  await stopListenersOnPort(port);
}

function startServer() {
  if (!fs.existsSync(serverEntry)) {
    console.error(`Missing build output: ${serverEntry}`);
    console.error("Run `pnpm build` first.");
    process.exitCode = 1;
    return;
  }

  const stdout = fs.openSync(outLog, "a");
  const stderr = fs.openSync(errLog, "a");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });

  child.unref();

  try {
    writePid(child.pid);
  } catch {
    // The PID file is best-effort. Port-based control still works if it cannot be written.
  }

  console.log(`Started server on pid ${child.pid}.`);
}

async function stopServer() {
  const pid = readPid();
  if (pid && (await killPid(pid))) {
    clearPidFile();
    console.log(`Stopped server pid ${pid}.`);
    return true;
  }

  const listeners = findListeningPids(serverPort);
  if (listeners.length === 0) {
    clearPidFile();
    console.log("No server listening on port 4318.");
    return true;
  }

  let allStopped = true;
  for (const listenerPid of listeners) {
    const stopped = await killPid(listenerPid);
    allStopped = stopped && allStopped;
    if (stopped) {
      console.log(`Stopped server pid ${listenerPid}.`);
    } else {
      console.error(`Failed to stop server pid ${listenerPid}.`);
    }
  }

  clearPidFile();
  if (!allStopped) {
    process.exitCode = 1;
  }

  return allStopped;
}

function statusServer() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`running ${pid}`);
    return;
  }

  const listeners = findListeningPids(serverPort);
  if (listeners.length > 0) {
    console.log(`running ${listeners[0]}`);
    return;
  }

  console.log("stopped");
}

const command = process.argv[2];

(async () => {
  switch (command) {
    case "start":
      await ensurePortFree(serverPort);
      startServer();
      break;
    case "stop":
      await stopServer();
      break;
    case "restart":
      await stopServer();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await ensurePortFree(serverPort);
      startServer();
      break;
    case "status":
      statusServer();
      break;
    default:
      console.log("Usage: node scripts/server-control.cjs <start|stop|restart|status>");
      process.exitCode = 1;
  }
})();

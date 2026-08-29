const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_BASE_URL = "http://127.0.0.1:4318";
const DEFAULT_WIDTH = 390;
const DEFAULT_HEIGHT = 844;
const DEFAULT_VIEW = "home";
const DEFAULT_OUTPUT = path.join("tmp-art-test", "mobile-preview.png");

const parseArgs = () => {
  const values = {};

  for (const rawArg of process.argv.slice(2)) {
    if (!rawArg.startsWith("--")) {
      continue;
    }

    const arg = rawArg.slice(2);

    if (arg === "menu") {
      values.menu = "true";
      continue;
    }

    const [key, ...rest] = arg.split("=");
    values[key] = rest.join("=");
  }

  return values;
};

const args = parseArgs();

const baseUrl = args["base-url"] || process.env.PREVIEW_BASE_URL || DEFAULT_BASE_URL;
const email = args.email || process.env.PREVIEW_EMAIL;
const password = args.password || process.env.PREVIEW_PASSWORD;
const view = args.view || DEFAULT_VIEW;
const width = Number(args.width || DEFAULT_WIDTH);
const height = Number(args.height || DEFAULT_HEIGHT);
const showMenu = args.menu === "true";
const outputPath = path.resolve(process.cwd(), args.out || DEFAULT_OUTPUT);

const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const findEdgePath = () => edgeCandidates.find((candidate) => fs.existsSync(candidate));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const ensureValidNumber = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) {
    fail(`Invalid ${label}.`);
  }
};

const buildPreviewUrl = (token) => {
  const redirectUrl = new URL("/", baseUrl);
  redirectUrl.searchParams.set("view", view);

  if (showMenu) {
    redirectUrl.searchParams.set("mobileMenu", "1");
  }

  const previewUrl = new URL("/preview-login", baseUrl);
  previewUrl.searchParams.set("token", token);
  previewUrl.searchParams.set("redirect", `${redirectUrl.pathname}${redirectUrl.search}`);
  return previewUrl.toString();
};

const login = async () => {
  if (!email || !password) {
    fail("Set PREVIEW_EMAIL and PREVIEW_PASSWORD or pass --email=... --password=... .");
  }

  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password
    })
  }).catch((error) => {
    fail(`Could not reach ${baseUrl}. Start the app server first. (${error.message})`);
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    fail(body?.message ? `Login failed: ${body.message}` : `Login failed with status ${response.status}.`);
  }

  const payload = await response.json();

  if (!payload?.token) {
    fail("Login succeeded but no session token was returned.");
  }

  return payload.token;
};

const captureScreenshot = (edgePath, targetUrl) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const result = spawnSync(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      `--screenshot=${outputPath}`,
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=5000",
      targetUrl
    ],
    {
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(details ? `Edge screenshot failed:\n${details}` : "Edge screenshot failed.");
  }

  if (!fs.existsSync(outputPath)) {
    fail("Screenshot command finished but no image file was created.");
  }
};

const run = async () => {
  ensureValidNumber(width, "width");
  ensureValidNumber(height, "height");

  const edgePath = findEdgePath();

  if (!edgePath) {
    fail("Could not find Microsoft Edge. Set EDGE_PATH to the full msedge.exe path.");
  }

  const token = await login();
  const previewUrl = buildPreviewUrl(token);
  captureScreenshot(edgePath, previewUrl);

  console.log(`Saved mobile preview to ${outputPath}`);
  console.log(`Preview URL: ${previewUrl}`);
};

void run();

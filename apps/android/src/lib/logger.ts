import * as FileSystem from "expo-file-system";

const LOG_DIRECTORY = `${FileSystem.documentDirectory ?? ""}diagnostics`;
export const APP_LOG_FILE_PATH = `${LOG_DIRECTORY}/app.log`;
export const NATIVE_APP_LOG_FILE_PATH = `${LOG_DIRECTORY}/native.log`;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let logWriteQueue = Promise.resolve();
let loggingEnabled = false;
let logSessionContext: Record<string, unknown> | null = null;

type LogLevel = "INFO" | "WARN" | "ERROR";

const ensureLogDirectory = async () => {
  if (!FileSystem.documentDirectory) {
    return;
  }

  const info = await FileSystem.getInfoAsync(LOG_DIRECTORY);

  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(LOG_DIRECTORY, { intermediates: true });
  }
};

const serializeValue = (value: unknown): string => {
  if (value instanceof Error) {
    return JSON.stringify(
      {
        name: value.name,
        message: value.message,
        stack: value.stack
      },
      null,
      2
    );
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const trimLog = (contents: string) => {
  if (contents.length <= MAX_LOG_BYTES) {
    return contents;
  }

  return contents.slice(contents.length - MAX_LOG_BYTES);
};

const appendLogLine = (level: LogLevel, message: string, details?: unknown) => {
  if (!loggingEnabled || !FileSystem.documentDirectory) {
    return Promise.resolve();
  }

  logWriteQueue = logWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await ensureLogDirectory();

      const info = await FileSystem.getInfoAsync(APP_LOG_FILE_PATH);
      const existing = info.exists ? await FileSystem.readAsStringAsync(APP_LOG_FILE_PATH) : "";
      const mergedDetails =
        logSessionContext && details !== undefined
          ? { _session: logSessionContext, details }
          : logSessionContext
            ? { _session: logSessionContext }
            : details;
      const detailSuffix = mergedDetails === undefined ? "" : `\n${serializeValue(mergedDetails)}`;
      const nextContents = trimLog(`${existing}[${new Date().toISOString()}] ${level} ${message}${detailSuffix}\n\n`);
      await FileSystem.writeAsStringAsync(APP_LOG_FILE_PATH, nextContents, {
        encoding: FileSystem.EncodingType.UTF8
      });
    });

  // Logging should never block playback, navigation, or UI work.
  return Promise.resolve();
};

export const setAppLoggingEnabled = (enabled: boolean) => {
  loggingEnabled = enabled;
};

export const setAppLogSessionContext = (context: Record<string, unknown> | null) => {
  logSessionContext = context;
};

export const getAppLoggingEnabled = () => loggingEnabled;

export const logInfo = async (message: string, details?: unknown) => appendLogLine("INFO", message, details);

export const logWarn = async (message: string, details?: unknown) => appendLogLine("WARN", message, details);

export const logError = async (message: string, error?: unknown, details?: unknown) =>
  appendLogLine("ERROR", message, {
    error: error === undefined ? null : serializeValue(error),
    details
  });

export const readAppLog = async () => {
  if (!FileSystem.documentDirectory) {
    return "Diagnostics storage is unavailable on this device.";
  }

  await ensureLogDirectory();
  const [appInfo, nativeInfo] = await Promise.all([FileSystem.getInfoAsync(APP_LOG_FILE_PATH), FileSystem.getInfoAsync(NATIVE_APP_LOG_FILE_PATH)]);
  const [appContents, nativeContents] = await Promise.all([
    appInfo.exists ? FileSystem.readAsStringAsync(APP_LOG_FILE_PATH) : Promise.resolve(""),
    nativeInfo.exists ? FileSystem.readAsStringAsync(NATIVE_APP_LOG_FILE_PATH) : Promise.resolve("")
  ]);

  if (!appContents && !nativeContents) {
    return "";
  }

  const sections = [];
  if (appContents) {
    sections.push(`=== JavaScript Diagnostics (${APP_LOG_FILE_PATH}) ===\n${appContents}`);
  }
  if (nativeContents) {
    sections.push(`=== Native Android Diagnostics (${NATIVE_APP_LOG_FILE_PATH}) ===\n${nativeContents}`);
  }
  return sections.join("\n\n");
};

export const clearAppLog = async () => {
  if (!FileSystem.documentDirectory) {
    return;
  }

  await ensureLogDirectory();
  await FileSystem.deleteAsync(APP_LOG_FILE_PATH, { idempotent: true });
  await FileSystem.deleteAsync(NATIVE_APP_LOG_FILE_PATH, { idempotent: true });
};

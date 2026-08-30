import type { Dirent } from "node:fs";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryRepository } from "../storage/library-repository.js";

type MobileCoverJobDependencies = {
  repository: LibraryRepository;
};

type SharpLike = {
  default: (input: Uint8Array | Buffer) => {
    resize: (width: number, height: number, options: { fit: "cover"; position: "center" }) => {
      jpeg: (options: { quality: number; mozjpeg: boolean }) => {
        toBuffer: () => Promise<Buffer>;
      };
    };
  };
};

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4b"]);
const SOURCE_COVER_NAMES = ["cover.jpg", "cover.jpeg", "folder.jpg", "front.jpg", "album.jpg", "cover.png"];
export const MOBILE_COVER_FILE_NAME = "cover_mobile500x500.jpg";
const MOBILE_COVER_SIZE = 500;
const MOBILE_COVER_QUALITY = 68;

let sharpModulePromise: Promise<SharpLike | null> | null = null;

const loadSharp = async () => {
  if (!sharpModulePromise) {
    sharpModulePromise = (new Function("return import('sharp')")() as Promise<SharpLike>)
      .catch(() => null);
  }

  return sharpModulePromise;
};

const uniqueRoots = (roots: string[]) => [...new Set(roots.map((root) => root.trim()).filter(Boolean))];

const selectSourceCoverPath = async (folderPath: string) => {
  for (const name of SOURCE_COVER_NAMES) {
    const candidate = path.join(folderPath, name);

    try {
      const candidateStats = await stat(candidate);

      if (candidateStats.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
};

export const findMobileCoverPathForTrack = async (trackFilePath: string) => {
  const folderPath = path.dirname(trackFilePath);
  const mobileCoverPath = path.join(folderPath, MOBILE_COVER_FILE_NAME);

  try {
    const mobileCoverStats = await stat(mobileCoverPath);
    return mobileCoverStats.isFile() ? mobileCoverPath : null;
  } catch {
    return null;
  }
};

const folderHasAudioFiles = (entries: Dirent[]) =>
  entries.some((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));

const normalizeScheduleDate = (value: Date) => value.toISOString().slice(0, 10);

export const createMobileCoverJobs = ({ repository }: MobileCoverJobDependencies) => {
  let timer: NodeJS.Timeout | undefined;
  let runningJob: Promise<void> | null = null;
  let lastRunDate: string | null = null;
  const status: {
    id: "mobile-cover-art";
    label: string;
    description: string;
    isEnabled: boolean;
    isRunning: boolean;
    scheduleTime: string | null;
    processedItems: number;
    totalItems: number;
    progressPercent: number;
    currentItemPath: string | null;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastError: string | null;
  } = {
    id: "mobile-cover-art",
    label: "Generate mobile cover art",
    description: "Create cropped 500x500 mobile cover files for faster Android browsing and offline sync.",
    isEnabled: repository.getAppSettings().mobileOptimizedCoversEnabled,
    isRunning: false,
    scheduleTime: repository.getAppSettings().mobileOptimizedCoverJobTime,
    processedItems: 0,
    totalItems: 0,
    progressPercent: 0,
    currentItemPath: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null
  };

  const syncStatusFromSettings = () => {
    const settings = repository.getAppSettings();
    status.isEnabled = settings.mobileOptimizedCoversEnabled;
    status.scheduleTime = settings.mobileOptimizedCoverJobTime;
  };

  const updateProgress = () => {
    status.progressPercent = status.totalItems > 0
      ? Math.max(0, Math.min(100, Math.round((status.processedItems / status.totalItems) * 100)))
      : status.isRunning
        ? 0
        : 100;
  };

  const generateMobileCoverForFolder = async (folderPath: string) => {
    const sharp = await loadSharp();

    if (!sharp) {
      return;
    }

    const sourcePath = await selectSourceCoverPath(folderPath);

    if (!sourcePath) {
      return;
    }

    const targetPath = path.join(folderPath, MOBILE_COVER_FILE_NAME);
    const [sourceStats, targetStats] = await Promise.all([
      stat(sourcePath),
      stat(targetPath).catch(() => null)
    ]);

    if (targetStats && targetStats.mtimeMs >= sourceStats.mtimeMs) {
      return;
    }

    const sourceBuffer = await readFile(sourcePath);
    const outputBuffer = await sharp.default(sourceBuffer)
      .resize(MOBILE_COVER_SIZE, MOBILE_COVER_SIZE, {
        fit: "cover",
        position: "center"
      })
      .jpeg({
        quality: MOBILE_COVER_QUALITY,
        mozjpeg: true
      })
      .toBuffer();

    await writeFile(targetPath, outputBuffer);
  };

  const walkFolders = async (rootPath: string, seenFolders: Set<string>) => {
    let entries: Dirent[];

    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return;
    }

    const canonicalFolder = path.resolve(rootPath);

    if (!seenFolders.has(canonicalFolder) && folderHasAudioFiles(entries)) {
      seenFolders.add(canonicalFolder);
      status.totalItems += 1;
      updateProgress();
      status.currentItemPath = rootPath;
      await generateMobileCoverForFolder(rootPath);
      status.processedItems += 1;
      updateProgress();
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      await walkFolders(path.join(rootPath, entry.name), seenFolders);
    }
  };

  const runJob = async () => {
    const settings = repository.getAppSettings();
    syncStatusFromSettings();

    if (!settings.mobileOptimizedCoversEnabled) {
      return;
    }

    status.isRunning = true;
    status.lastStartedAt = new Date().toISOString();
    status.currentItemPath = null;
    status.processedItems = 0;
    status.totalItems = 0;
    status.progressPercent = 0;
    status.lastError = null;

    const roots = uniqueRoots([...settings.libraryRoots, ...settings.bookRoots]);
    const seenFolders = new Set<string>();

    try {
      for (const root of roots) {
        try {
          await access(root);
        } catch {
          continue;
        }

        await walkFolders(root, seenFolders);
      }
      status.lastCompletedAt = new Date().toISOString();
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : "Mobile cover job failed";
      throw error;
    } finally {
      status.isRunning = false;
      status.currentItemPath = null;
      updateProgress();
    }
  };

  const shouldRunAtCurrentTime = (timeValue: string) => {
    const [hoursText, minutesText] = timeValue.split(":");
    const scheduledHours = Number(hoursText);
    const scheduledMinutes = Number(minutesText);

    if (!Number.isInteger(scheduledHours) || !Number.isInteger(scheduledMinutes)) {
      return false;
    }

    const now = new Date();
    const todayKey = normalizeScheduleDate(now);

    if (lastRunDate === todayKey) {
      return false;
    }

    return now.getHours() > scheduledHours || (now.getHours() === scheduledHours && now.getMinutes() >= scheduledMinutes);
  };

  const startRun = () => {
    if (runningJob) {
      return;
    }

    runningJob = runJob().finally(() => {
      lastRunDate = normalizeScheduleDate(new Date());
      runningJob = null;
    });
  };

  const tick = () => {
    const settings = repository.getAppSettings();

    if (!settings.mobileOptimizedCoversEnabled) {
      return;
    }

    if (shouldRunAtCurrentTime(settings.mobileOptimizedCoverJobTime)) {
      startRun();
    }
  };

  const schedule = () => {
    timer = setInterval(tick, 60_000);
    tick();
  };

  const resetSchedule = () => {
    syncStatusFromSettings();
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    schedule();
  };

  return {
    getStatus() {
      syncStatusFromSettings();
      return {
        scheduled: [{ ...status }]
      };
    },
    async start() {
      syncStatusFromSettings();
      schedule();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }

      if (runningJob) {
        await runningJob;
      }
    },
    resetSchedule,
    triggerRunNow() {
      if (runningJob) {
        return false;
      }

      startRun();
      return true;
    },
    runNow: async () => {
      if (runningJob) {
        await runningJob;
        return;
      }

      startRun();
      if (runningJob) {
        await runningJob;
      }
    }
  };
};

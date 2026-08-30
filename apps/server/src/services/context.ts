import { createConfig } from "../settings/config.js";
import { createLibraryRepository } from "../storage/library-repository.js";
import { createMobileCoverJobs } from "./mobile-cover-jobs.js";
import { createScanner } from "./scanner.js";

export const createAppContext = () => {
  const config = createConfig();
  const repository = createLibraryRepository(config.databasePath);
  repository.ensureDefaultSettings({
    libraryRoots: config.defaultLibraryRoots,
    bookRoots: config.defaultBookRoots,
    scanIntervalMinutes: config.defaultScanIntervalMinutes,
    queueAlbumTracksOnPlay: true,
    promptBeforeReplacingQueueOnPlay: true,
    showEntityMetadataOnHeroImage: true,
    mobileOptimizedCoversEnabled: true,
    mobileOptimizedCoverJobTime: "03:00"
  });
  const scanner = createScanner({
    defaultScanIntervalMinutes: config.defaultScanIntervalMinutes,
    repository,
    discogsAuth: config.discogs
  });
  const mobileCoverJobs = createMobileCoverJobs({
    repository
  });

  return {
    config,
    repository,
    scanner,
    mobileCoverJobs
  };
};

import { createConfig } from "../settings/config.js";
import { createLibraryRepository } from "../storage/library-repository.js";
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
    showEntityMetadataOnHeroImage: true
  });
  const scanner = createScanner({
    defaultScanIntervalMinutes: config.defaultScanIntervalMinutes,
    repository,
    discogsAuth: config.discogs
  });

  return {
    config,
    repository,
    scanner
  };
};

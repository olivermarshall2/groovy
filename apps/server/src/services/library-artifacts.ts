import { constants } from "node:fs";
import { access, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadDiscogsReleaseCoverArt, searchDiscogsAlbumCandidates, type DiscogsAuth } from "./discogs.js";
import { normalizeGenreLabels, normalizeGenreValue } from "./genre.js";
import { downloadMusicBrainzReleaseCoverArt, lookupMusicBrainzArtist, lookupMusicBrainzRelease } from "./musicbrainz.js";
import { lookupTheAudioDbAlbumArtwork, lookupTheAudioDbAlbumDescription } from "./theaudiodb.js";

type ArtifactLogger = {
  debug: (data: Record<string, unknown>, message: string) => void;
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
  error: (data: Record<string, unknown>, message: string) => void;
};

export type ScannedTrackArtifact = {
  filePath: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  discNumber: number | null;
  trackNumber: number | null;
  durationSeconds: number | null;
  musicBrainzReleaseId: string | null;
  musicBrainzArtistId: string | null;
  musicBrainzAlbumArtistId: string | null;
};

type SyncArtifactsInput = {
  root: string;
  tracks: ScannedTrackArtifact[];
  pushError: (filePath: string, message: string) => void;
  discogsAuth: DiscogsAuth | null;
};

type AlbumFolder = {
  folderPath: string;
  tracks: ScannedTrackArtifact[];
};

export type AlbumIdentificationInput = {
  folderPath: string;
  tracks: ScannedTrackArtifact[];
  title: string;
  artist: string;
  albumArtist: string;
  year: number | null;
  genre: string | null;
  review: string | null;
  outline: string | null;
  coverArtResolver: () => Promise<{ data: Uint8Array; fileExtension: ".jpg" | ".png" } | null>;
  logger?: ArtifactLogger;
};

const escapeXml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const canWritePath = async (targetPath: string) => {
  try {
    await access(targetPath, constants.F_OK);
    await access(targetPath, constants.W_OK);
    return true;
  } catch {
    try {
      await access(path.dirname(targetPath), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
};

const canWriteFolderArtwork = async (folderPath: string, baseName: string) => {
  for (const extension of [".jpg", ".jpeg", ".png"]) {
    const targetPath = path.join(folderPath, `${baseName}${extension}`);

    try {
      await access(targetPath, constants.F_OK);
      await access(targetPath, constants.W_OK);
      return true;
    } catch {
      continue;
    }
  }

  try {
    await access(folderPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const writeFileOrIgnoreEperm = async (filePath: string, contents: string) => {
  try {
    await writeFile(filePath, contents, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
};

const folderHasJpeg = async (folderPath: string) => {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && [".jpg", ".jpeg"].includes(path.extname(entry.name).toLowerCase()));
  } catch {
    return false;
  }
};

const readTextIfExists = async (filePath: string) => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

const extractTag = (source: string, tagName: string) => {
  const match = source.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? match[1]?.trim() || null : null;
};

const uniqueValues = (values: Array<string | null | undefined>) =>
  [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];

const formatDateAdded = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const formatRuntimeMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

const formatTrackDuration = (seconds: number | null) => {
  if (!seconds || seconds <= 0) {
    return "00:00";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
};

const sortTracks = (tracks: ScannedTrackArtifact[]) =>
  [...tracks].sort((left, right) => {
    const discDifference = (left.discNumber ?? 0) - (right.discNumber ?? 0);

    if (discDifference !== 0) {
      return discDifference;
    }

    const trackDifference = (left.trackNumber ?? 0) - (right.trackNumber ?? 0);

    if (trackDifference !== 0) {
      return trackDifference;
    }

    return (left.title ?? left.filePath).localeCompare(right.title ?? right.filePath);
  });

const downloadRemoteArtwork = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.5"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`Artwork request failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "image/jpeg";
  const fileExtension: ".jpg" | ".png" = contentType.includes("png") ? ".png" : ".jpg";

  return {
    data: new Uint8Array(await response.arrayBuffer()),
    fileExtension
  };
};

type SharpModule = {
  default: (input: Buffer) => {
    jpeg: (options: { quality: number }) => {
      toBuffer: () => Promise<Buffer>;
    };
  };
};

let sharpModulePromise: Promise<SharpModule | null> | null = null;

const loadSharp = async () => {
  if (!sharpModulePromise) {
    sharpModulePromise = (new Function("return import('sharp')")() as Promise<SharpModule>)
      .then((module) => module)
      .catch(() => null);
  }

  return sharpModulePromise;
};

const removeFolderArtwork = async (folderPath: string, baseName: string) => {
  for (const extension of [".jpg", ".jpeg", ".png"]) {
    try {
      await unlink(path.join(folderPath, `${baseName}${extension}`));
    } catch {
      continue;
    }
  }
};

const writeFolderArtwork = async (
  folderPath: string,
  baseName: string,
  resolver: () => Promise<{ data: Uint8Array; fileExtension: ".jpg" | ".png" } | null>,
  replaceExisting = false,
  logger?: ArtifactLogger
) => {
  if (!replaceExisting && (await folderHasJpeg(folderPath))) {
    logger?.debug({ folderPath, baseName }, "Skipping artwork write because matching JPEG already exists");
    return;
  }

  if (!(await canWriteFolderArtwork(folderPath, baseName))) {
    logger?.warn({ folderPath, baseName }, "Skipping artwork write because folder is not writable");
    return;
  }

  if (replaceExisting) {
    await removeFolderArtwork(folderPath, baseName);
  }

  const artwork = await resolver();

  if (!artwork) {
    logger?.warn({ folderPath, baseName }, "Artwork resolver returned no image");
    return;
  }

  try {
    const sharp = await loadSharp();
    const canConvertToJpeg = artwork.fileExtension === ".png" && sharp;
    const targetExtension = baseName === "cover" ? (canConvertToJpeg ? ".jpg" : artwork.fileExtension) : artwork.fileExtension;
    const outputData =
      targetExtension === ".jpg" && artwork.fileExtension === ".png" && sharp
        ? await sharp.default(Buffer.from(artwork.data)).jpeg({ quality: 92 }).toBuffer()
        : Buffer.from(artwork.data);

    const targetPath = path.join(folderPath, `${baseName}${targetExtension}`);
    await writeFile(targetPath, outputData);
    logger?.info(
      {
        folderPath,
        baseName,
        targetPath,
        sourceExtension: artwork.fileExtension,
        targetExtension,
        convertedToJpeg: targetExtension === ".jpg" && artwork.fileExtension === ".png",
        imageConversionAvailable: Boolean(sharp)
      },
      "Artwork written to disk"
    );
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EPERM") {
      logger?.error(
        {
          folderPath,
          baseName,
          message: error instanceof Error ? error.message : "Unknown error"
        },
        "Failed to write artwork"
      );
      throw error;
    }
  }
};

let artifactWriteQueue: Promise<void> = Promise.resolve();

const withArtifactWriteLock = async <T>(action: () => Promise<T>) => {
  const run = artifactWriteQueue.then(action, action);
  artifactWriteQueue = run.then(
    () => undefined,
    () => undefined
  );

  return run;
};

const renderAlbumNfo = (album: {
  title: string;
  year: number | null;
  genre: string | null;
  artist: string;
  albumArtist: string;
  review: string | null;
  outline: string | null;
  tracks: ScannedTrackArtifact[];
}) => {
  const sortedTracks = sortTracks(album.tracks);
  const totalSeconds = sortedTracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0);
  const year = album.year;
  const date = year ? `${year}-01-01` : null;
  const trackNodes = sortedTracks
    .map((track, index) => {
      const disc = track.discNumber ?? 1;
      const position = track.trackNumber ?? index + 1;
      const title = track.title ?? path.basename(track.filePath, path.extname(track.filePath));
      return [
        "  <track>",
        `    <disc>${disc}</disc>`,
        `    <position>${position}</position>`,
        `    <title>${escapeXml(title)}</title>`,
        `    <duration>${formatTrackDuration(track.durationSeconds)}</duration>`,
        "  </track>"
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<album>",
    album.review ? `  <review>${escapeXml(album.review)}</review>` : "  <review />",
    album.outline ? `  <outline>${escapeXml(album.outline)}</outline>` : "  <outline />",
    "  <lockdata>false</lockdata>",
    `  <dateadded>${formatDateAdded()}</dateadded>`,
    `  <title>${escapeXml(album.title)}</title>`,
    year ? `  <year>${year}</year>` : null,
    `  <sorttitle>${escapeXml(album.title)}</sorttitle>`,
    date ? `  <premiered>${date}</premiered>` : null,
    date ? `  <releasedate>${date}</releasedate>` : null,
    `  <runtime>${formatRuntimeMinutes(totalSeconds)}</runtime>`,
    `  <genre>${escapeXml(album.genre ?? "Other")}</genre>`,
    "  <art />",
    `  <artist>${escapeXml(album.artist)}</artist>`,
    `  <albumartist>${escapeXml(album.albumArtist)}</albumartist>`,
    trackNodes,
    "</album>",
    ""
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

const renderArtistNfo = (artistFolderName: string, albums: Array<{ title: string; year: number | null; runtimeMinutes: number; genre: string | null }>, outline: string | null) => {
  const totalRuntime = albums.reduce((total, album) => total + album.runtimeMinutes, 0);
  const genre = normalizeGenreLabels(albums.map((album) => album.genre)).join(", ") || "Other";
  const albumNodes = albums
    .sort((left, right) => (left.year ?? 0) - (right.year ?? 0) || left.title.localeCompare(right.title))
    .map(
      (album) => [
        "  <album>",
        `    <title>${escapeXml(album.title)}</title>`,
        album.year ? `    <year>${album.year}</year>` : null,
        "  </album>"
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<artist>",
    outline ? `  <biography>${escapeXml(outline)}</biography>` : "  <biography />",
    outline ? `  <outline>${escapeXml(outline)}</outline>` : "  <outline />",
    "  <lockdata>false</lockdata>",
    `  <dateadded>${formatDateAdded()}</dateadded>`,
    `  <title>${escapeXml(artistFolderName)}</title>`,
    `  <runtime>${totalRuntime}</runtime>`,
    `  <genre>${escapeXml(genre)}</genre>`,
    "  <studio />",
    "  <art />",
    albumNodes,
    "</artist>",
    ""
  ].join("\n");
};

export const writeAlbumIdentification = async ({
  folderPath,
  tracks,
  title,
  artist,
  albumArtist,
  year,
  genre,
  review,
  outline,
  coverArtResolver,
  logger
}: AlbumIdentificationInput) => {
  return withArtifactWriteLock(async () => {
    const albumNfoPath = path.join(folderPath, "album.nfo");

    await writeFolderArtwork(folderPath, "cover", coverArtResolver, true, logger);

    if (await canWritePath(albumNfoPath)) {
      await writeFileOrIgnoreEperm(
        albumNfoPath,
        renderAlbumNfo({
          title,
          year,
          genre,
          artist,
          albumArtist,
          review,
          outline,
          tracks
        })
      );
    }
  });
};

export const syncLibraryArtifacts = async ({ root, tracks, pushError, discogsAuth }: SyncArtifactsInput) => {
  return withArtifactWriteLock(async () => {
    const albumFolders = new Map<string, ScannedTrackArtifact[]>();
    for (const track of tracks) {
      const folderPath = path.dirname(track.filePath);
      const bucket = albumFolders.get(folderPath) ?? [];
      bucket.push(track);
      albumFolders.set(folderPath, bucket);
    }

    const albumFolderEntries: AlbumFolder[] = [...albumFolders.entries()].map(([folderPath, folderTracks]) => ({
      folderPath,
      tracks: folderTracks
    }));

    for (const albumFolder of albumFolderEntries) {
      const albumNfoPath = path.join(albumFolder.folderPath, "album.nfo");
      const artistNfoPath = path.join(albumFolder.folderPath, "artist.nfo");

      try {
        const sortedTracks = sortTracks(albumFolder.tracks);
        const firstTrack = sortedTracks[0];
        const title = firstTrack?.album ?? path.basename(albumFolder.folderPath);
        const albumArtist = firstTrack?.albumArtist ?? firstTrack?.artist ?? path.basename(path.dirname(albumFolder.folderPath));

        await writeFolderArtwork(
          albumFolder.folderPath,
          "cover",
          async () => {
            if (discogsAuth) {
              const discogsCandidates = await searchDiscogsAlbumCandidates(albumArtist, title, discogsAuth);
              const selectedDiscogsReleaseId = discogsCandidates[0]?.id ?? null;

              if (selectedDiscogsReleaseId) {
                const discogsArtwork = await downloadDiscogsReleaseCoverArt(selectedDiscogsReleaseId, discogsAuth);

                if (discogsArtwork) {
                  return discogsArtwork;
                }
              }
            }

            const musicBrainzArtwork = await downloadMusicBrainzReleaseCoverArt(firstTrack?.musicBrainzReleaseId ?? null);

            if (musicBrainzArtwork) {
              return musicBrainzArtwork;
            }

            const theAudioDbUrl = await lookupTheAudioDbAlbumArtwork(albumArtist, title);
            return theAudioDbUrl ? downloadRemoteArtwork(theAudioDbUrl) : null;
          },
          false
        );

        const existingAlbumNfo = await readTextIfExists(albumNfoPath);
        const existingReview = existingAlbumNfo ? extractTag(existingAlbumNfo, "review") : null;
        const existingOutline = existingAlbumNfo ? extractTag(existingAlbumNfo, "outline") : null;
        const releaseInfo = await lookupMusicBrainzRelease(firstTrack?.musicBrainzReleaseId ?? null);
        const resolvedTitle = releaseInfo?.title ?? title;
        const year = releaseInfo?.year ?? sortedTracks.find((track) => track.year)?.year ?? null;
        const genre = normalizeGenreValue(releaseInfo?.genre ?? (uniqueValues(sortedTracks.map((track) => track.genre)).join(", ") || null));
        const artist = firstTrack?.artist ?? albumArtist;
        const albumDescription =
          existingReview ??
          existingOutline ??
          (await lookupTheAudioDbAlbumDescription(albumArtist, resolvedTitle)) ??
          (await lookupMusicBrainzArtist(firstTrack?.musicBrainzAlbumArtistId ?? firstTrack?.musicBrainzArtistId ?? null))?.outline ??
          null;

        if (await canWritePath(albumNfoPath)) {
          await writeFileOrIgnoreEperm(
            albumNfoPath,
            renderAlbumNfo({
              title: resolvedTitle,
              year,
              genre,
              artist,
              albumArtist,
              review: albumDescription,
              outline: albumDescription,
              tracks: sortedTracks
            })
          );
        }

        const artistInfo = await lookupMusicBrainzArtist(firstTrack?.musicBrainzAlbumArtistId ?? firstTrack?.musicBrainzArtistId ?? null);
        const artistFolderName = artistInfo?.name ?? albumArtist;
        const totalSeconds = sortedTracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0);

        if (await canWritePath(artistNfoPath)) {
          await writeFileOrIgnoreEperm(
            artistNfoPath,
            renderArtistNfo(
              artistFolderName,
              [
                {
                  title: resolvedTitle,
                  year,
                  runtimeMinutes: formatRuntimeMinutes(totalSeconds),
                  genre
                }
              ],
              artistInfo?.outline ?? null
            )
          );
        }
      } catch (error) {
        pushError(albumNfoPath, error instanceof Error ? error.message : "Failed to write album.nfo");
      }
    }
  });
};

export const identifyAlbumArtifacts = async ({ root, tracks, pushError, discogsAuth }: SyncArtifactsInput) => {
  return withArtifactWriteLock(async () => {
    const albumFolderEntries = [
    {
      folderPath: path.dirname(tracks[0]?.filePath ?? root),
      tracks: [...tracks]
    }
  ];

  for (const albumFolder of albumFolderEntries) {
    const albumNfoPath = path.join(albumFolder.folderPath, "album.nfo");

    try {
      const sortedTracks = sortTracks(albumFolder.tracks);
      const firstTrack = sortedTracks[0];
      const title = firstTrack?.album ?? path.basename(albumFolder.folderPath);
      const albumArtist = firstTrack?.albumArtist ?? firstTrack?.artist ?? path.basename(path.dirname(albumFolder.folderPath));

      await writeFolderArtwork(
        albumFolder.folderPath,
        "cover",
        async () => {
          if (discogsAuth) {
            const discogsCandidates = await searchDiscogsAlbumCandidates(albumArtist, title, discogsAuth);
            const selectedDiscogsReleaseId = discogsCandidates[0]?.id ?? null;

            if (selectedDiscogsReleaseId) {
              const discogsArtwork = await downloadDiscogsReleaseCoverArt(selectedDiscogsReleaseId, discogsAuth);

              if (discogsArtwork) {
                return discogsArtwork;
              }
            }
          }

          const musicBrainzArtwork = await downloadMusicBrainzReleaseCoverArt(firstTrack?.musicBrainzReleaseId ?? null);

          if (musicBrainzArtwork) {
            return musicBrainzArtwork;
          }

          const theAudioDbUrl = await lookupTheAudioDbAlbumArtwork(albumArtist, title);
          return theAudioDbUrl ? downloadRemoteArtwork(theAudioDbUrl) : null;
        },
        true
      );

      const releaseInfo = await lookupMusicBrainzRelease(firstTrack?.musicBrainzReleaseId ?? null);
      const resolvedTitle = releaseInfo?.title ?? title;
      const year = releaseInfo?.year ?? sortedTracks.find((track) => track.year)?.year ?? null;
      const genre = normalizeGenreValue(releaseInfo?.genre ?? (uniqueValues(sortedTracks.map((track) => track.genre)).join(", ") || null));
      const artist = firstTrack?.artist ?? albumArtist;
      const albumDescription =
        (await lookupTheAudioDbAlbumDescription(albumArtist, resolvedTitle)) ??
        (await lookupMusicBrainzArtist(firstTrack?.musicBrainzAlbumArtistId ?? firstTrack?.musicBrainzArtistId ?? null))?.outline ??
        null;

      if (await canWritePath(albumNfoPath)) {
        await writeFileOrIgnoreEperm(
          albumNfoPath,
          renderAlbumNfo({
            title: resolvedTitle,
            year,
            genre,
            artist,
            albumArtist,
            review: albumDescription,
            outline: albumDescription,
            tracks: sortedTracks
          })
        );
      }
    } catch (error) {
      pushError(albumNfoPath, error instanceof Error ? error.message : "Failed to identify album");
    }
    }
  });
};

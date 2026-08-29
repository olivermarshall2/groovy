import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth.js";
import { readAlbumDetailFromNfo } from "../services/nfo-reader.js";
import { type ScannedTrackArtifact, writeAlbumIdentification } from "../services/library-artifacts.js";
import { persistBookStateSidecar } from "../services/book-state-sidecar.js";
import { downloadDiscogsArtwork, downloadDiscogsReleaseCoverArt, lookupDiscogsRelease, searchDiscogsAlbumCandidates } from "../services/discogs.js";
import { searchMusicBrainzArtist, searchMusicBrainzRelease } from "../services/musicbrainz.js";
import { lookupTheAudioDbAlbumDescription } from "../services/theaudiodb.js";
import { updateAlbumTags, updateTrackTags } from "../services/tag-editor.js";

const parseOptionalYear = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
  }

  return null;
};

const parseOptionalPositiveInteger = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
  }

  return null;
};

const parseOptionalText = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveCommonFolder = (paths: string[]) => {
  if (paths.length === 0) {
    return null;
  }

  const splitPath = (value: string) =>
    path
      .resolve(value)
      .split(path.sep)
      .filter(Boolean);

  const [firstPath, ...remainingPaths] = paths.map(splitPath);
  const sharedParts = [...firstPath];

  for (const currentPath of remainingPaths) {
    let index = 0;

    while (index < sharedParts.length && index < currentPath.length && sharedParts[index]?.toLowerCase() === currentPath[index]?.toLowerCase()) {
      index += 1;
    }

    sharedParts.length = index;

    if (sharedParts.length === 0) {
      break;
    }
  }

  return sharedParts.length > 0 ? sharedParts.join(path.sep) : null;
};

const buildSyncTrack = (track: {
  id: string;
  title: string | null;
  artist: string | null;
  author: string | null;
  album: string | null;
  durationSeconds: number | null;
  format: string;
  sizeBytes: number;
  coverArtId: string | null;
}) => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  author: track.author,
  album: track.album,
  durationSeconds: track.durationSeconds,
  format: track.format,
  sizeBytes: track.sizeBytes,
  coverArtId: track.coverArtId,
  streamPath: `/api/library/stream/${encodeURIComponent(track.id)}`,
  downloadPath: `/api/library/download/${encodeURIComponent(track.id)}`
});

const buildSmartPlaylists = (
  tracks: Array<{
    id: string;
    title: string | null;
    artist: string | null;
    albumArtist: string | null;
    albumId: string;
    coverArtId: string | null;
    durationSeconds: number | null;
    modifiedAt: string;
  }>,
  albums: Array<{ id: string }>,
  artists: Array<{ name: string }>
) => {
  const recentlyAdded = [...tracks].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, 25);
  const eveningAlbums = albums
    .slice(0, 3)
    .flatMap((album) => tracks.filter((track) => track.albumId === album.id))
    .slice(0, 20);
  const artistSpotlight = artists
    .slice(0, 3)
    .flatMap((artist) => tracks.filter((track) => track.artist === artist.name || track.albumArtist === artist.name))
    .slice(0, 24);
  const longPlay = [...tracks].sort((left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0)).slice(0, 20);
  const createdAt = "smart-playlist";

  return [
    {
      id: "smart:recently-added",
      name: "Recently Added",
      description: "Freshly indexed tracks from your library.",
      createdAt,
      trackCount: recentlyAdded.length,
      durationSeconds: recentlyAdded.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      coverArtId: recentlyAdded[0]?.coverArtId ?? null,
      tracks: recentlyAdded,
      accent: "cool" as const,
      isSmart: true
    },
    {
      id: "smart:after-hours",
      name: "After Hours Queue",
      description: "A mellow run built from the albums at the front of your collection.",
      createdAt,
      trackCount: eveningAlbums.length,
      durationSeconds: eveningAlbums.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      coverArtId: eveningAlbums[0]?.coverArtId ?? null,
      tracks: eveningAlbums,
      accent: "sunset" as const,
      isSmart: true
    },
    {
      id: "smart:artist-spotlight",
      name: "Artist Spotlight",
      description: "A rotating set from the most visible artists in your index.",
      createdAt,
      trackCount: artistSpotlight.length,
      durationSeconds: artistSpotlight.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      coverArtId: artistSpotlight[0]?.coverArtId ?? null,
      tracks: artistSpotlight,
      accent: "warm" as const,
      isSmart: true
    },
    {
      id: "smart:long-play",
      name: "Long Play",
      description: "Longer tracks for uninterrupted listening.",
      createdAt,
      trackCount: longPlay.length,
      durationSeconds: longPlay.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
      coverArtId: longPlay[0]?.coverArtId ?? null,
      tracks: longPlay,
      accent: "cool" as const,
      isSmart: true
    }
  ].filter((playlist) => playlist.tracks.length > 0);
};

export const registerLibraryRoutes = async (server: FastifyInstance) => {
  server.get("/api/library/summary", {
    schema: {
      summary: "Get a summary of indexed library data"
    }
  }, async (request) => {
    requireAuth(server, request);
    return server.appContext.repository.getLibrarySummary();
  });

  server.get("/api/library/tracks", {
    schema: {
      summary: "List indexed tracks"
    }
  }, async (request) => {
    requireAuth(server, request);
    return server.appContext.repository.listTracks();
  });

  server.get("/api/library/artists", {
    schema: {
      summary: "List indexed artists"
    }
  }, async (request) => {
    requireAuth(server, request);
    return server.appContext.repository.listArtists();
  });

  server.get("/api/library/albums", {
    schema: {
      summary: "List indexed albums"
    }
  }, async (request) => {
    requireAuth(server, request);
    return server.appContext.repository.listAlbums();
  });

  server.get("/api/library/books", {
    schema: {
      summary: "List indexed books with current-user resume state"
    }
  }, async (request) => {
    const user = requireAuth(server, request);
    return server.appContext.repository.listBooks(user.id);
  });

  server.get("/api/library/books/:id", {
    schema: {
      summary: "Get book detail, chapter list, resume state, and bookmarks"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { id } = request.params as { id: string };
    const detail = server.appContext.repository.getBookDetail(user.id, id);

    if (!detail) {
      reply.status(404);
      return {
        message: "Book not found"
      };
    }

    return detail;
  });

  server.get("/api/library/albums/:id", {
    schema: {
      summary: "Get album detail, track list, and NFO metadata"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const album = server.appContext.repository.getAlbumById(id);

    if (!album) {
      reply.status(404);
      return {
        message: "Album not found"
      };
    }

    const tracks = server.appContext.repository.listTracksByAlbum(album.id);
    return readAlbumDetailFromNfo(album, tracks);
  });

  server.get("/api/library/albums/:id/sync", {
    schema: {
      summary: "Get a mobile sync bundle for an album"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const album = server.appContext.repository.getAlbumById(id);

    if (!album) {
      reply.status(404);
      return {
        message: "Album not found"
      };
    }

    const tracks = server.appContext.repository.listTracksByAlbum(album.id);

    return {
      kind: "album" as const,
      album,
      tracks: tracks.map(buildSyncTrack)
    };
  });

  server.post("/api/library/albums/:id/identify", {
    schema: {
      summary: "Identify an album against Discogs with MusicBrainz fallback"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const album = server.appContext.repository.getAlbumById(id);

    if (!album) {
      reply.status(404);
      return {
        message: "Album not found"
      };
    }

    const tracks = server.appContext.repository.listTracksByAlbum(album.id);

    if (tracks.length === 0) {
      reply.status(404);
      return {
        message: "Album tracks not found"
      };
    }

    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      candidateId?: number | string;
      previewOnly?: unknown;
      filters?: {
        artist?: unknown;
        albumArtist?: unknown;
        year?: unknown;
        genre?: unknown;
      };
    };
    const candidateId = body.candidateId === undefined ? null : Number(body.candidateId);
    const selectedCandidateId = candidateId !== null && Number.isFinite(candidateId) && candidateId > 0 ? candidateId : null;
    const previewOnly = body.previewOnly === true;
    const firstTrack = tracks[0]!;
    const albumArtist = firstTrack.albumArtist ?? firstTrack.artist ?? album.artist;
    const discogsAuth = server.appContext.config.discogs;
    const discogsSearchLogger = server.log.child({
      album: album.name,
      albumArtist,
      source: "discogs"
    });
    const discogsCandidates = await searchDiscogsAlbumCandidates(albumArtist, album.name, discogsAuth, {
      artist: parseOptionalText(body.filters?.artist),
      albumArtist: parseOptionalText(body.filters?.albumArtist),
      year: parseOptionalYear(body.filters?.year),
      genre: parseOptionalText(body.filters?.genre)
    }, discogsSearchLogger);

    if (selectedCandidateId === null && (previewOnly || discogsCandidates.length > 0)) {
      return {
        status: "needs-selection",
        source: "discogs",
        candidates: discogsCandidates.map((candidate) => ({
          id: candidate.id,
          source: "discogs" as const,
          title: candidate.title,
          artist: candidate.artist,
          year: candidate.year,
          country: candidate.country,
          label: candidate.label,
          format: candidate.format,
          thumbUrl: candidate.thumbUrl
        }))
      };
    }

    const identifyTracks: ScannedTrackArtifact[] = tracks.map((track) => ({
      filePath: track.filePath,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumArtist: track.albumArtist,
      genre: track.genre,
      year: track.year,
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      durationSeconds: track.durationSeconds,
      musicBrainzReleaseId: null,
      musicBrainzArtistId: null,
      musicBrainzAlbumArtistId: null
    }));

    const root = resolveCommonFolder(tracks.map((track) => path.dirname(track.filePath))) ?? path.dirname(firstTrack.filePath);
    const selectedDiscogsReleaseId = selectedCandidateId ?? discogsCandidates[0]?.id ?? null;

    if (selectedDiscogsReleaseId) {
      const release = await lookupDiscogsRelease(selectedDiscogsReleaseId, discogsAuth);

      if (release) {
        const coverArtResolver = async () =>
          downloadDiscogsArtwork(release.imageUrl, discogsAuth) ?? downloadDiscogsReleaseCoverArt(selectedDiscogsReleaseId, discogsAuth);

        const identifyLogger = server.log.child({
          album: album.name,
          albumArtist,
          albumFolder: root,
          discogsReleaseId: selectedDiscogsReleaseId
        });

        identifyLogger.info(
          {
            trackCount: identifyTracks.length,
            releaseTitle: release.title ?? album.name,
            releaseHasImage: Boolean(release.imageUrl)
          },
          "Writing Discogs identification artifacts"
        );

        await writeAlbumIdentification({
          folderPath: root,
          tracks: identifyTracks,
          title: release.title ?? album.name,
          artist: release.artist ?? album.artist,
          albumArtist,
          year: release.year ?? firstTrack.year ?? null,
          genre: release.genre ?? firstTrack.genre ?? null,
          review: release.notes ?? null,
          outline: release.notes ?? null,
          coverArtResolver,
          logger: identifyLogger
        });

        identifyLogger.info({ albumFolder: root }, "Discogs identification artifacts written");
        await server.appContext.scanner.runFolderScan(root, "manual");

        return {
          identified: true,
          source: "discogs",
          releaseId: selectedDiscogsReleaseId
        };
      }
    }

    const releaseInfo = await searchMusicBrainzRelease(albumArtist, album.name);
    const resolvedTitle = releaseInfo?.title ?? album.name;
    const year = releaseInfo?.year ?? tracks.find((track) => track.year)?.year ?? null;
    const genre = releaseInfo?.genre ?? (tracks.map((track) => track.genre).filter(Boolean).join(", ") || null);
    const artistInfo = await searchMusicBrainzArtist(albumArtist);
    const description = (await lookupTheAudioDbAlbumDescription(albumArtist, resolvedTitle)) ?? artistInfo?.outline ?? null;

    const identifyLogger = server.log.child({
      album: album.name,
      albumArtist,
      albumFolder: root,
      source: "musicbrainz"
    });

    identifyLogger.info(
      {
        trackCount: identifyTracks.length,
        resolvedTitle
      },
      "Writing fallback identification artifacts"
    );

    await writeAlbumIdentification({
      folderPath: root,
      tracks: identifyTracks,
      title: resolvedTitle,
      artist: firstTrack.artist ?? album.artist,
      albumArtist,
      year,
      genre,
      review: description,
      outline: description,
      coverArtResolver: async () => null,
      logger: identifyLogger
    });

    identifyLogger.info({ albumFolder: root }, "Fallback identification artifacts written");
    await server.appContext.scanner.runFolderScan(root, "manual");

    return {
      identified: true,
      source: "musicbrainz",
      releaseId: releaseInfo?.releaseId ?? null
    };
  });

  server.put("/api/library/albums/:id/media-kind", {
    schema: {
      summary: "Manually classify an album group as music or book"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      mediaKind?: unknown;
    };
    const mediaKind = body.mediaKind === "book" ? "book" : body.mediaKind === "music" ? "music" : null;

    if (!mediaKind) {
      reply.status(400);
      return {
        message: "mediaKind must be 'music' or 'book'"
      };
    }

    const result = server.appContext.repository.classifyAlbumMediaKind(id, mediaKind);

    if (!result) {
      reply.status(404);
      return {
        message: "Album group not found"
      };
    }

    return result;
  });

  server.put("/api/library/albums/:id/tags", {
    schema: {
      summary: "Edit album-level ID3 tags for every track in an album"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      artist?: unknown;
      albumArtist?: unknown;
      album?: unknown;
      year?: unknown;
      genre?: unknown;
    };
    const result = await updateAlbumTags(
      server.appContext.repository,
      id,
      {
        artist: parseOptionalText(body.artist),
        albumArtist: parseOptionalText(body.albumArtist),
        album: parseOptionalText(body.album),
        year: parseOptionalYear(body.year),
        genre: parseOptionalText(body.genre)
      },
      server.appContext.config.discogs,
      server.log
    );

    if (!result) {
      reply.status(404);
      return {
        message: "Album not found"
      };
    }

    const album = server.appContext.repository.getAlbumById(result.albumId);

    if (!album) {
      reply.status(404);
      return {
        message: "Updated album not found"
      };
    }

    const detail = await readAlbumDetailFromNfo(album, result.tracks);
    return {
      albumId: result.albumId,
      detail
    };
  });

  server.put("/api/library/tracks/:id/tags", {
    schema: {
      summary: "Edit track-level ID3 tags for a single track"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      title?: unknown;
      trackNumber?: unknown;
      discNumber?: unknown;
    };
    const track = await updateTrackTags(
      server.appContext.repository,
      id,
      {
        title: parseOptionalText(body.title),
        trackNumber: parseOptionalPositiveInteger(body.trackNumber),
        discNumber: parseOptionalPositiveInteger(body.discNumber)
      },
      server.appContext.config.discogs,
      server.log
    );

    if (!track) {
      reply.status(404);
      return {
        message: "Track not found"
      };
    }

    return {
      track
    };
  });

  server.get("/api/library/cover-art/:id", {
    schema: {
      summary: "Read cover art for a track, album, or artist"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const coverArt = server.appContext.repository.getCoverArtById(id);

    if (!coverArt) {
      reply.status(404);
      return {
        message: "Cover art not found"
      };
    }

    reply.header("Cache-Control", "no-store, max-age=0, must-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");

    return reply.type(coverArt.mimeType).send(Buffer.from(coverArt.data));
  });

  server.get("/api/library/stream/:id", {
    schema: {
      summary: "Stream a local track for the web player"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const track = server.appContext.repository.getTrackById(id);

    if (!track) {
      reply.status(404);
      return {
        message: "Track not found"
      };
    }

    const fileStats = await stat(track.filePath);
    const rangeHeader = request.headers.range;
    const contentType = track.format === "flac" ? "audio/flac" : track.format === "m4b" ? "audio/mp4" : "audio/mpeg";

    if (!rangeHeader) {
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", fileStats.size);
      return reply.type(contentType).send(createReadStream(track.filePath));
    }

    const [startText, endText] = rangeHeader.replace("bytes=", "").split("-");
    const start = Number(startText);
    const end = endText ? Number(endText) : fileStats.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileStats.size) {
      reply.status(416);
      return reply.send();
    }

    reply.status(206);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Range", `bytes ${start}-${end}/${fileStats.size}`);
    reply.header("Content-Length", end - start + 1);
    return reply.type(contentType).send(createReadStream(track.filePath, { start, end }));
  });

  server.get("/api/library/download/:id", {
    schema: {
      summary: "Download a local track for offline mobile sync"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { id } = request.params as { id: string };
    const track = server.appContext.repository.getTrackById(id);

    if (!track) {
      reply.status(404);
      return {
        message: "Track not found"
      };
    }

    const fileStats = await stat(track.filePath);
    const contentType = track.format === "flac" ? "audio/flac" : track.format === "m4b" ? "audio/mp4" : "audio/mpeg";
    const safeTitle = (track.title ?? path.parse(track.filePath).name).replace(/[^\w\s.-]+/g, "").trim() || "track";
    const extension = track.format === "m4b" ? "m4b" : track.format === "flac" ? "flac" : "mp3";

    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", fileStats.size);
    reply.header("Content-Disposition", `attachment; filename="${safeTitle}.${extension}"`);
    return reply.type(contentType).send(createReadStream(track.filePath));
  });

  server.post("/api/library/rescan", {
    schema: {
      summary: "Trigger an immediate library scan"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const result = server.appContext.scanner.requestScan("manual");

    return {
      accepted: true,
      queued: result === "queued"
    };
  });

  server.post("/api/library/rescan-folder", {
    schema: {
      summary: "Trigger an immediate scan for a single folder"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      root?: unknown;
    };
    const root = typeof body.root === "string" ? body.root.trim() : "";

    if (!root) {
      reply.status(400);
      return {
        message: "root is required"
      };
    }

    await stat(root);
    await server.appContext.scanner.runFolderScan(root, "manual");

    return {
      accepted: true,
      root
    };
  });

  server.put("/api/library/books/:id/progress", {
    schema: {
      summary: "Save the current user's latest listening position for a book"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { id } = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      trackId?: string;
      positionSeconds?: number;
    };
    const book = server.appContext.repository.getBookById(user.id, id);

    if (!book) {
      reply.status(404);
      return { message: "Book not found" };
    }

    if (!body.trackId) {
      reply.status(400);
      return { message: "trackId is required" };
    }

    const track = server.appContext.repository.getTrackById(body.trackId);

    if (!track || track.bookId !== id) {
      reply.status(404);
      return { message: "Book track not found" };
    }

    server.appContext.repository.saveBookProgress(user.id, id, track.id, Number(body.positionSeconds ?? 0));
    await persistBookStateSidecar(server.appContext.repository, id);

    return {
      progress: server.appContext.repository.getBookProgress(user.id, id)
    };
  });

  server.post("/api/library/books/:id/bookmarks", {
    schema: {
      summary: "Create a bookmark in a book for the current user"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { id } = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as {
      trackId?: string;
      positionSeconds?: number;
      label?: string;
    };
    const book = server.appContext.repository.getBookById(user.id, id);

    if (!book) {
      reply.status(404);
      return { message: "Book not found" };
    }

    if (!body.trackId) {
      reply.status(400);
      return { message: "trackId is required" };
    }

    const track = server.appContext.repository.getTrackById(body.trackId);

    if (!track || track.bookId !== id) {
      reply.status(404);
      return { message: "Book track not found" };
    }

    const bookmark = server.appContext.repository.createBookBookmark(
      user.id,
      id,
      track.id,
      Number(body.positionSeconds ?? 0),
      typeof body.label === "string" ? body.label : null
    );
    await persistBookStateSidecar(server.appContext.repository, id);
    reply.status(201);
    return bookmark;
  });

  server.get("/api/library/books/:id/sync", {
    schema: {
      summary: "Get a mobile sync bundle for a book"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { id } = request.params as { id: string };
    const detail = server.appContext.repository.getBookDetail(user.id, id);

    if (!detail) {
      reply.status(404);
      return {
        message: "Book not found"
      };
    }

    return {
      kind: "book" as const,
      book: detail.book,
      tracks: detail.tracks.map(buildSyncTrack),
      progress: detail.progress,
      bookmarks: detail.bookmarks
    };
  });

  server.post("/api/library/history", {
    schema: {
      summary: "Record a played track event"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const body = request.body as { trackId?: string };

    if (!body.trackId) {
      reply.status(400);
      return {
        message: "trackId is required"
      };
    }

    const track = server.appContext.repository.getTrackById(body.trackId);

    if (!track) {
      reply.status(404);
      return {
        message: "Track not found"
      };
    }

    server.appContext.repository.recordTrackPlay(user.id, track.id, new Date().toISOString());

    reply.status(204);
    return reply.send();
  });

  server.get("/api/library/recently-played", {
    schema: {
      summary: "List recently played tracks for the current user"
    }
  }, async (request) => {
    const user = requireAuth(server, request);
    return server.appContext.repository.listRecentlyPlayed(user.id);
  });

  server.get("/api/library/likes", {
    schema: {
      summary: "List liked track ids for the current user"
    }
  }, async (request) => {
    const user = requireAuth(server, request);
    return {
      trackIds: server.appContext.repository.listLikedTrackIds(user.id)
    };
  });

  server.post("/api/library/likes/:trackId", {
    schema: {
      summary: "Like a track"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { trackId } = request.params as { trackId: string };
    const track = server.appContext.repository.getTrackById(trackId);

    if (!track) {
      reply.status(404);
      return { message: "Track not found" };
    }

    server.appContext.repository.likeTrack(user.id, track.id);
    reply.status(204);
    return reply.send();
  });

  server.delete("/api/library/likes/:trackId", {
    schema: {
      summary: "Unlike a track"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { trackId } = request.params as { trackId: string };
    server.appContext.repository.unlikeTrack(user.id, trackId);
    reply.status(204);
    return reply.send();
  });

  server.get("/api/library/playlists", {
    schema: {
      summary: "List playlists for the current user"
    }
  }, async (request) => {
    const user = requireAuth(server, request);
    const userPlaylists = server.appContext.repository.listPlaylists(user.id);
    const smartPlaylists = buildSmartPlaylists(
      server.appContext.repository.listTracks(),
      server.appContext.repository.listAlbums(),
      server.appContext.repository.listArtists()
    );
    return [...userPlaylists, ...smartPlaylists];
  });

  server.get("/api/library/playlists/:playlistId/sync", {
    schema: {
      summary: "Get a mobile sync bundle for a playlist"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const { playlistId } = request.params as { playlistId: string };
    const playlist = server.appContext.repository.getPlaylistById(user.id, playlistId);

    if (!playlist) {
      reply.status(404);
      return {
        message: "Playlist not found"
      };
    }

    return {
      kind: "playlist" as const,
      playlist: {
        id: playlist.id,
        name: playlist.name,
        createdAt: playlist.createdAt,
        trackCount: playlist.trackCount,
        durationSeconds: playlist.durationSeconds,
        coverArtId: playlist.coverArtId
      },
      tracks: playlist.tracks.map(buildSyncTrack)
    };
  });

  server.post("/api/library/playlists", {
    schema: {
      summary: "Create a playlist"
    }
  }, async (request, reply) => {
    const user = requireAuth(server, request);
    const body = request.body as { name?: string };

    if (!body.name?.trim()) {
      reply.status(400);
      return { message: "name is required" };
    }

    return server.appContext.repository.createPlaylist(user.id, body.name);
  });

  server.post("/api/library/playlists/:playlistId/tracks", {
    schema: {
      summary: "Add a track to a playlist"
    }
  }, async (request, reply) => {
    requireAuth(server, request);
    const { playlistId } = request.params as { playlistId: string };
    const body = request.body as { trackId?: string };

    if (!body.trackId) {
      reply.status(400);
      return { message: "trackId is required" };
    }

    const track = server.appContext.repository.getTrackById(body.trackId);

    if (!track) {
      reply.status(404);
      return { message: "Track not found" };
    }

    server.appContext.repository.addTrackToPlaylist(playlistId, track.id);
    reply.status(204);
    return reply.send();
  });
};

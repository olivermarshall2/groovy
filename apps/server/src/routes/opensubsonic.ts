import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AlbumRecord, AppUser, ArtistRecord, BookRecord, TrackRecord } from "@mp3-platform/shared";
import { persistBookStateSidecar } from "../services/book-state-sidecar.js";
import { readAlbumDetailFromNfo } from "../services/nfo-reader.js";

const SUBSONIC_API_VERSION = "1.16.1";
const OPEN_SUBSONIC_VERSION = "1";
const SERVER_TYPE = "mp3-platform";
const SERVER_VERSION = "0.1.0";
const TEMP_REQUEST_LOG = path.resolve(process.cwd(), "apps/server/data/opensubsonic-requests.log");

type SubsonicParams = Record<string, string>;

const getParams = (request: FastifyRequest): SubsonicParams => {
  const source = {
    ...(request.query as Record<string, string | string[] | undefined>),
    ...((request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body
      : {}) as Record<string, string | string[] | undefined>)
  };
  const result: SubsonicParams = {};

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      result[key] = value[0] ?? "";
      continue;
    }

    result[key] = value ?? "";
  }

  return result;
};

const normalizeSearchQuery = (value: string | undefined) => {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return "";
  }

  const unwrapped = trimmed.match(/^"(.*)"$/)?.[1] ?? trimmed;
  return unwrapped === '""' ? "" : unwrapped.trim();
};

const sliceByOffsetCount = <T,>(items: T[], offsetValue: string | undefined, countValue: string | undefined) => {
  const offset = Math.max(0, Number.parseInt(offsetValue ?? "0", 10) || 0);
  const count = Math.max(0, Number.parseInt(countValue ?? "0", 10) || 0);

  if (count === 0) {
    return [];
  }

  return items.slice(offset, offset + count);
};

const sanitizeXml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");

const toXml = (name: string, value: unknown): string => {
  if (value === null || value === undefined) {
    return `<${name}/>`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toXml(name, item)).join("");
  }

  if (typeof value !== "object") {
    return `<${name}>${sanitizeXml(value)}</${name}>`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const attributes = entries
    .filter(([, item]) => item === null || typeof item !== "object")
    .map(([key, item]) => `${key}="${sanitizeXml(item ?? "")}"`)
    .join(" ");
  const children = entries
    .filter(([, item]) => item !== null && typeof item === "object")
    .map(([key, item]) => toXml(key, item))
    .join("");

  if (!attributes && !children) {
    return `<${name}/>`;
  }

  if (!children) {
    return `<${name}${attributes ? ` ${attributes}` : ""}/>`;
  }

  return `<${name}${attributes ? ` ${attributes}` : ""}>${children}</${name}>`;
};

const sendSubsonicResponse = (
  reply: FastifyReply,
  params: SubsonicParams,
  payload: Record<string, unknown>
) => {
  const responseBody = {
    "subsonic-response": {
      status: "ok",
      version: SUBSONIC_API_VERSION,
      type: SERVER_TYPE,
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      ...payload
    }
  };

  if (params.f === "json") {
    return reply.send(responseBody);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>${toXml("subsonic-response", responseBody["subsonic-response"])}`;
  return reply.type("application/xml").send(xml);
};

const sendSubsonicError = (
  reply: FastifyReply,
  params: SubsonicParams,
  code: number,
  message: string,
  statusCode = 400
) => {
  reply.status(statusCode);

  const payload = {
    error: {
      code,
      message
    }
  };

  const responseBody = {
    "subsonic-response": {
      status: "failed",
      version: SUBSONIC_API_VERSION,
      type: SERVER_TYPE,
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      ...payload
    }
  };

  if (params.f === "json") {
    return reply.send(responseBody);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>${toXml("subsonic-response", responseBody["subsonic-response"])}`;
  return reply.type("application/xml").send(xml);
};

const decodePassword = (password: string) => {
  if (!password.startsWith("enc:")) {
    return password;
  }

  try {
    return Buffer.from(password.slice(4), "hex").toString("utf8");
  } catch {
    return password;
  }
};

const createTokenHash = (password: string, salt: string) =>
  createHash("md5").update(`${password}${salt}`).digest("hex");

const getOpenSubsonicUser = (server: FastifyInstance, params: SubsonicParams): AppUser | null => {
  if (params.apiKey) {
    const apiKeyUser = server.appContext.repository.getUserByApiKey(params.apiKey);

    if (apiKeyUser) {
      return apiKeyUser;
    }

    if (params.apiKey === server.appContext.config.subsonic.apiKey) {
      return server.appContext.repository.getFirstUser();
    }
  }

  const username = params.u;
  const password = decodePassword(params.p ?? "");
  const token = params.t ?? "";
  const salt = params.s ?? "";

  if (
    username === server.appContext.config.subsonic.username &&
    token &&
    salt &&
    token.toLowerCase() === createTokenHash(server.appContext.config.subsonic.password, salt)
  ) {
    return server.appContext.repository.getFirstUser();
  }

  if (
    username === server.appContext.config.subsonic.username &&
    password === server.appContext.config.subsonic.password
  ) {
    return server.appContext.repository.getFirstUser();
  }

  return null;
};

const ensureAuth = (server: FastifyInstance, reply: FastifyReply, params: SubsonicParams) => {
  const user = getOpenSubsonicUser(server, params);

  if (user) {
    return user;
  }

  sendSubsonicError(reply, params, 40, "Wrong username or password.", 401);
  return null;
};

const getContentType = (track: TrackRecord) => {
  if (track.format === "flac") {
    return "audio/flac";
  }

  if (track.format === "m4b") {
    return "audio/mp4";
  }

  return "audio/mpeg";
};

const asChild = (track: TrackRecord, parentId?: string) => ({
  id: track.id,
  parent: parentId ?? (track.mediaKind === "book" ? track.bookId ?? track.albumId : track.albumId),
  albumId: track.albumId,
  artistId: track.artistId,
  isDir: false,
  title: track.title ?? path.basename(track.filePath, path.extname(track.filePath)),
  album: track.mediaKind === "book" ? track.bookTitle ?? track.album ?? "Unknown Book" : track.album ?? "Unknown Album",
  artist: track.artist ?? "Unknown Artist",
  albumArtist: track.albumArtist ?? track.artist ?? "Unknown Artist",
  albumArtistId: track.albumArtistId ?? track.artistId,
  track: track.trackNumber ?? 0,
  discNumber: track.discNumber ?? 0,
  duration: track.durationSeconds ?? 0,
  bitRate: track.bitrate ? Math.round(track.bitrate / 1000) : 0,
  size: track.sizeBytes,
  suffix: track.format,
  contentType: getContentType(track),
  path: track.filePath,
  genre: track.genre ?? "",
  coverArt: track.coverArtId ?? "",
  type: track.mediaKind === "book" ? "audiobook" : "music",
  mediaType: track.mediaKind === "book" ? "audiobook" : "music"
});

const asAlbum = (album: AlbumRecord, tracks: TrackRecord[] = []) => {
  const year = tracks.find((track) => track.year)?.year ?? null;
  const genre = tracks.find((track) => track.genre)?.genre ?? null;
  const albumArtist = tracks.find((track) => track.albumArtist)?.albumArtist ?? album.artist;
  const albumArtistId = tracks.find((track) => track.albumArtistId)?.albumArtistId ?? album.artistId;

  return {
    id: album.id,
    artistId: album.artistId,
    artist: album.artist,
    albumArtist,
    albumArtistId,
    name: album.name,
    title: album.name,
    songCount: album.songCount,
    duration: album.durationSeconds,
    coverArt: album.coverArtId ?? "",
    year: year ?? undefined,
    genre: genre ?? undefined
  };
};

const asArtist = (artist: ArtistRecord) => ({
  id: artist.id,
  name: artist.name,
  albumCount: artist.albumCount
});

const asBookAlbum = (book: BookRecord, tracks: TrackRecord[] = []) => ({
  id: book.id,
  artistId: tracks[0]?.albumArtistId ?? tracks[0]?.artistId ?? "",
  artist: book.author,
  albumArtist: book.author,
  albumArtistId: tracks[0]?.albumArtistId ?? tracks[0]?.artistId ?? "",
  name: book.title,
  title: book.title,
  songCount: book.trackCount,
  duration: book.durationSeconds,
  coverArt: book.coverArtId ?? "",
  year: tracks.find((track) => track.year)?.year ?? undefined,
  genre: tracks.find((track) => track.genre)?.genre ?? "Audiobook"
});

const asSubsonicBookmark = (bookmark: { id: string; trackId: string; positionSeconds: number; label: string | null; createdAt: string }, track: TrackRecord) => ({
  id: bookmark.id,
  position: bookmark.positionSeconds * 1000,
  username: "",
  comment: bookmark.label ?? "",
  created: bookmark.createdAt,
  changed: bookmark.createdAt,
  entry: asChild(track, track.bookId ?? track.albumId)
});

const getAlbumArtistEntries = (albums: AlbumRecord[], albumTracks: Map<string, TrackRecord[]>) => {
  const albumArtistMap = new Map<string, { id: string; name: string; albumCount: number }>();

  for (const album of albums) {
    const tracks = albumTracks.get(album.id) ?? [];
    const albumArtistName = tracks.find((track) => track.albumArtist)?.albumArtist ?? album.artist;
    const albumArtistId = tracks.find((track) => track.albumArtistId)?.albumArtistId ?? album.artistId;
    const existing = albumArtistMap.get(albumArtistId);

    if (existing) {
      existing.albumCount += 1;
      continue;
    }

    albumArtistMap.set(albumArtistId, {
      id: albumArtistId,
      name: albumArtistName,
      albumCount: 1
    });
  }

  return [...albumArtistMap.values()].sort((left, right) => left.name.localeCompare(right.name));
};

const groupAlbumArtistIndexes = (entries: { id: string; name: string; albumCount: number }[]) => {
  const indexes = new Map<string, { id: string; name: string; albumCount: number }[]>();

  for (const entry of entries) {
    const indexName = entry.name.charAt(0).toUpperCase() || "#";
    const indexBucket = /[A-Z]/.test(indexName) ? indexName : "#";
    const bucket = indexes.get(indexBucket) ?? [];
    bucket.push(entry);
    indexes.set(indexBucket, bucket);
  }

  return [...indexes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bucket]) => ({
      name,
      artist: bucket.sort((left, right) => left.name.localeCompare(right.name))
    }));
};

const asUser = (user: { name: string; email: string }) => ({
  username: user.name,
  email: user.email,
  scrobblingEnabled: true,
  adminRole: true,
  settingsRole: true,
  downloadRole: true,
  uploadRole: false,
  playlistRole: true,
  coverArtRole: true,
  commentRole: false,
  podcastRole: false,
  streamRole: true,
  jukeboxRole: false,
  shareRole: false,
  videoConversionRole: false,
  avatarLastChanged: 0
});

const asPlaylist = (
  playlist: { id: string; name: string; createdAt: string; tracks: TrackRecord[] },
  owner: string
) => ({
  id: playlist.id,
  name: playlist.name,
  songCount: playlist.tracks.length,
  duration: playlist.tracks.reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
  created: playlist.createdAt,
  changed: playlist.createdAt,
  coverArt: playlist.tracks.find((track) => track.coverArtId)?.coverArtId ?? "",
  owner,
  public: false
});

const getSubsonicUser = (server: FastifyInstance, params: SubsonicParams) =>
  getOpenSubsonicUser(server, params) ?? server.appContext.repository.getFirstUser();

const groupArtistIndexes = (artists: ArtistRecord[]) => {
  const indexes = new Map<string, ArtistRecord[]>();

  for (const artist of artists) {
    const indexName = artist.name.charAt(0).toUpperCase() || "#";
    const indexBucket = /[A-Z]/.test(indexName) ? indexName : "#";
    const bucket = indexes.get(indexBucket) ?? [];
    bucket.push(artist);
    indexes.set(indexBucket, bucket);
  }

  return [...indexes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bucket]) => ({
      name,
      artist: bucket.sort((left, right) => left.name.localeCompare(right.name)).map(asArtist)
    }));
};

const handleStream = async (
  server: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  params: SubsonicParams
) => {
  if (!ensureAuth(server, reply, params)) {
    return;
  }

  const id = params.id;

  if (!id) {
    return sendSubsonicError(reply, params, 10, "Missing track id.");
  }

  const track = server.appContext.repository.getTrackById(id);

  if (!track) {
    return sendSubsonicError(reply, params, 70, "Track not found.", 404);
  }

  const fileStats = await stat(track.filePath);
  const rangeHeader = request.headers.range;
  const contentType = getContentType(track);

  if (!rangeHeader) {
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", fileStats.size);
    reply.type(contentType);
    return reply.send(createReadStream(track.filePath));
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
  reply.type(contentType);

  return reply.send(createReadStream(track.filePath, { start, end }));
};

export const registerOpenSubsonicRoutes = async (server: FastifyInstance) => {
  server.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/rest/")) {
      return;
    }

    await appendFile(
      TEMP_REQUEST_LOG,
      `${new Date().toISOString()} request ${request.method} ${request.url} host=${request.headers.host ?? ""} ua=${request.headers["user-agent"] ?? ""} ip=${request.ip}\n`
    ).catch(() => undefined);

    request.log.info({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      userAgent: request.headers["user-agent"],
      remoteAddress: request.ip
    }, "OpenSubsonic request");
  });

  server.addHook("onResponse", async (request, reply) => {
    if (!request.url.startsWith("/rest/")) {
      return;
    }

    await appendFile(
      TEMP_REQUEST_LOG,
      `${new Date().toISOString()} response ${request.method} ${request.url} status=${reply.statusCode}\n`
    ).catch(() => undefined);

    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode
    }, "OpenSubsonic response");
  });

  server.route({
    method: ["GET", "POST"],
    url: "/rest/:endpoint",
    handler: async (request, reply) => {
      const params = getParams(request);
      const endpoint = (request.params as { endpoint: string }).endpoint.replace(/\.view$/, "");

      if (endpoint === "stream") {
        return handleStream(server, request, reply, params);
      }

      if (endpoint === "download") {
        return handleStream(server, request, reply, params);
      }

      if (endpoint === "ping") {
        return sendSubsonicResponse(reply, params, {});
      }

      const authenticatedUser = ensureAuth(server, reply, params);

      if (!authenticatedUser) {
        return;
      }

      switch (endpoint) {
        case "getLicense":
          return sendSubsonicResponse(reply, params, {
            license: {
              valid: true,
              email: "local@mp3-platform",
              licenseExpires: "2099-12-31T23:59:59Z"
            }
          });
        case "getOpenSubsonicExtensions":
          return sendSubsonicResponse(reply, params, {
            openSubsonicExtensions: {
              openSubsonicExtension: [
                { name: "apiKeyAuthentication", versions: OPEN_SUBSONIC_VERSION },
                { name: "getAlbumList", versions: OPEN_SUBSONIC_VERSION },
                { name: "getAlbumList2", versions: OPEN_SUBSONIC_VERSION },
                { name: "getAlbumArtist", versions: OPEN_SUBSONIC_VERSION },
                { name: "getAlbumArtists", versions: OPEN_SUBSONIC_VERSION },
                { name: "getOpenSubsonicExtensions", versions: OPEN_SUBSONIC_VERSION },
                { name: "getArtists", versions: OPEN_SUBSONIC_VERSION },
                { name: "getBookmarks", versions: OPEN_SUBSONIC_VERSION },
                { name: "getIndexes", versions: OPEN_SUBSONIC_VERSION },
                { name: "search3", versions: OPEN_SUBSONIC_VERSION },
                { name: "tokenInfo", versions: OPEN_SUBSONIC_VERSION }
              ]
            }
          });
        case "getTokenInfo":
        case "tokenInfo":
          if (!params.apiKey) {
            return sendSubsonicError(reply, params, 40, "Invalid API key.", 401);
          }

          if (!server.appContext.repository.getUserByApiKey(params.apiKey) && params.apiKey !== server.appContext.config.subsonic.apiKey) {
            return sendSubsonicError(reply, params, 40, "Invalid API key.", 401);
          }

          return sendSubsonicResponse(reply, params, {
            tokenInfo: {
              username: server.appContext.config.subsonic.username
            }
          });
        case "getMusicFolders": {
          const settings = server.appContext.repository.getAppSettings();
          const roots = [...settings.libraryRoots, ...settings.bookRoots];
          return sendSubsonicResponse(reply, params, {
            musicFolders: {
              musicFolder: roots.map((root: string, index: number) => ({
                id: String(index + 1),
                name: path.basename(root) || root
              }))
            }
          });
        }
        case "getIndexes": {
          const artists = server.appContext.repository.listArtists();
          const albumArtistEntries = getAlbumArtistEntries(
            server.appContext.repository.listAlbums(),
            new Map(server.appContext.repository.listAlbums().map((album) => [album.id, server.appContext.repository.listTracksByAlbum(album.id)]))
          );
          const useAlbumArtists = params.albumArtistsOnly === "true" || params.type === "albumArtists";
          return sendSubsonicResponse(reply, params, {
            indexes: {
              lastModified: Date.now(),
              ignoredArticles: "",
              index: useAlbumArtists ? groupAlbumArtistIndexes(albumArtistEntries) : groupArtistIndexes(artists)
            }
          });
        }
        case "getArtists": {
          const artists = server.appContext.repository.listArtists();
          const albumArtistEntries = getAlbumArtistEntries(
            server.appContext.repository.listAlbums(),
            new Map(server.appContext.repository.listAlbums().map((album) => [album.id, server.appContext.repository.listTracksByAlbum(album.id)]))
          );
          const useAlbumArtists = params.albumArtistsOnly === "true" || params.type === "albumArtists";
          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} getArtists-debug albumArtistsOnly=${params.albumArtistsOnly ?? ""} type=${params.type ?? ""} useAlbumArtists=${useAlbumArtists} artists=${artists.length} albumArtists=${albumArtistEntries.length}\n`
          ).catch(() => undefined);
          return sendSubsonicResponse(reply, params, {
            artists: {
              ignoredArticles: "",
              index: useAlbumArtists ? groupAlbumArtistIndexes(albumArtistEntries) : groupArtistIndexes(artists)
            }
          });
        }
        case "getAlbumArtists": {
          const albums = server.appContext.repository.listAlbums();
          const albumTracks = new Map<string, TrackRecord[]>();

          for (const album of albums) {
            albumTracks.set(album.id, server.appContext.repository.listTracksByAlbum(album.id));
          }

          const albumArtistEntries = getAlbumArtistEntries(albums, albumTracks);

          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} getAlbumArtists-debug total=${albumArtistEntries.length}\n`
          ).catch(() => undefined);

          return sendSubsonicResponse(reply, params, {
            albumArtists: {
              ignoredArticles: "",
              index: groupAlbumArtistIndexes(albumArtistEntries)
            },
            artists: {
              ignoredArticles: "",
              index: groupAlbumArtistIndexes(albumArtistEntries)
            }
          });
        }
        case "getAlbumArtist": {
          const artistId = params.id;
          const albums = server.appContext.repository.listAlbums();
          const albumTracks = new Map<string, TrackRecord[]>();

          for (const album of albums) {
            albumTracks.set(album.id, server.appContext.repository.listTracksByAlbum(album.id));
          }

          const albumArtistEntries = getAlbumArtistEntries(albums, albumTracks);
          const match = albumArtistEntries.find((entry) => entry.id === artistId || entry.name === artistId);

          if (!match) {
            return sendSubsonicError(reply, params, 70, "Artist not found.", 404);
          }

          const matchingAlbums = albums
            .filter((album) => {
              const tracks = albumTracks.get(album.id) ?? [];
              const albumArtistName = tracks.find((track) => track.albumArtist)?.albumArtist ?? album.artist;
              const albumArtistId = tracks.find((track) => track.albumArtistId)?.albumArtistId ?? album.artistId;
              return albumArtistId === match.id || albumArtistName === match.name;
            })
            .map((album) => asAlbum(album, albumTracks.get(album.id) ?? []));

          return sendSubsonicResponse(reply, params, {
            albumArtist: {
              id: match.id,
              name: match.name,
              albumCount: match.albumCount,
              album: matchingAlbums
            }
          });
        }
        case "getArtist": {
          const artistId = params.id;
          const artist = artistId ? server.appContext.repository.getArtistById(artistId) : null;

          if (!artist) {
            return sendSubsonicError(reply, params, 70, "Artist not found.", 404);
          }

          const albumIds = [...new Set(server.appContext.repository.listTracksByArtist(artist.id).map((track) => track.albumId))];
          const albums = albumIds
            .map((albumId) => server.appContext.repository.getAlbumById(albumId))
            .filter((album): album is AlbumRecord => Boolean(album))
            .map((album) => asAlbum(album, server.appContext.repository.listTracksByAlbum(album.id)));

          return sendSubsonicResponse(reply, params, {
            artist: {
              ...asArtist(artist),
              album: albums
            }
          });
        }
        case "getAlbum": {
          const albumId = params.id;
          const album = albumId ? server.appContext.repository.getAlbumById(albumId) : null;

          if (album) {
            const songs = server.appContext.repository.listTracksByAlbum(album.id).map((track) => asChild(track, album.id));

            return sendSubsonicResponse(reply, params, {
              album: {
                ...asAlbum(album, server.appContext.repository.listTracksByAlbum(album.id)),
                name: album.name,
                song: songs
              }
            });
          }

          const booksUser = getSubsonicUser(server, params);
          const book = albumId && booksUser ? server.appContext.repository.getBookById(booksUser.id, albumId) : null;

          if (!book) {
            return sendSubsonicError(reply, params, 70, "Album not found.", 404);
          }

          const bookTracks = server.appContext.repository.listTracksByBook(book.id);

          return sendSubsonicResponse(reply, params, {
            album: {
              ...asBookAlbum(book, bookTracks),
              name: book.title,
              song: bookTracks.map((track) => asChild(track, book.id))
            }
          });
        }
        case "getAlbumInfo":
        case "getAlbumInfo2": {
          const albumId = params.id;
          const album = albumId ? server.appContext.repository.getAlbumById(albumId) : null;

          if (!album) {
            return sendSubsonicError(reply, params, 70, "Album not found.", 404);
          }

          const tracks = server.appContext.repository.listTracksByAlbum(album.id);
          const detail = await readAlbumDetailFromNfo(album, tracks);

          return sendSubsonicResponse(reply, params, {
            albumInfo: {
              notes: detail.review ?? detail.outline ?? "",
              musicBrainzId: album.id,
              coverArt: album.coverArtId ?? "",
              year: detail.year ? String(detail.year) : "",
              genres: detail.genre ? { genre: [detail.genre] } : { genre: [] }
            }
          });
        }
        case "getArtistInfo":
        case "getArtistInfo2": {
          const artistId = params.id;
          const artist = artistId ? server.appContext.repository.getArtistById(artistId) : null;

          if (!artist) {
            return sendSubsonicError(reply, params, 70, "Artist not found.", 404);
          }

          return sendSubsonicResponse(reply, params, {
            artistInfo: {
              biography: "",
              musicBrainzId: artist.id,
              smallImageUrl: "",
              mediumImageUrl: "",
              largeImageUrl: "",
              similarArtist: []
            }
          });
        }
        case "getMusicDirectory": {
          const id = params.id;

          if (!id) {
            return sendSubsonicError(reply, params, 10, "Missing directory id.");
          }

          const settings = server.appContext.repository.getAppSettings();
          const musicFolderMatch = [...settings.libraryRoots, ...settings.bookRoots]
            .map((root: string, index: number) => ({ id: String(index + 1), name: path.basename(root) || root }))
            .find((folder) => folder.id === id);

          if (musicFolderMatch) {
            return sendSubsonicResponse(reply, params, {
              directory: {
                id: musicFolderMatch.id,
                name: musicFolderMatch.name,
              child: groupArtistIndexes(server.appContext.repository.listArtists()).flatMap((group) =>
                group.artist.map((artist) => ({
                  id: artist.id,
                  parent: musicFolderMatch.id,
                  isDir: true,
                  title: artist.name,
                  name: artist.name,
                  artist: artist.name,
                  albumCount: artist.albumCount,
                  coverArt: ""
                }))
              )
            }
          });
          }

          const artist = server.appContext.repository.getArtistById(id);

          if (artist) {
            const albumIds = [...new Set(server.appContext.repository.listTracksByArtist(artist.id).map((track) => track.albumId))];
            const childAlbums = albumIds
              .map((albumId) => server.appContext.repository.getAlbumById(albumId))
              .filter((album): album is AlbumRecord => Boolean(album))
              .map((album) => ({
                id: album.id,
                parent: artist.id,
                isDir: true,
                title: album.name,
                name: album.name,
                artist: album.artist,
                songCount: album.songCount,
                duration: album.durationSeconds,
                coverArt: album.coverArtId ?? ""
              }));

            return sendSubsonicResponse(reply, params, {
              directory: {
                id: artist.id,
                name: artist.name,
                child: childAlbums
              }
            });
          }

          const album = server.appContext.repository.getAlbumById(id);

          if (album) {
            return sendSubsonicResponse(reply, params, {
              directory: {
                id: album.id,
                name: album.name,
                child: server.appContext.repository.listTracksByAlbum(album.id).map((track) => asChild(track, album.id))
              }
            });
          }

          const booksUser = getSubsonicUser(server, params);
          const book = booksUser ? server.appContext.repository.getBookById(booksUser.id, id) : null;

          if (!book) {
            return sendSubsonicError(reply, params, 70, "Directory not found.", 404);
          }

          return sendSubsonicResponse(reply, params, {
            directory: {
              id: book.id,
              name: book.title,
              child: server.appContext.repository.listTracksByBook(book.id).map((track) => asChild(track, book.id))
            }
          });
        }
        case "getAlbumList2": {
          const type = params.type ?? "alphabeticalByName";
          const size = Number(params.size ?? "50");
          const offset = Number(params.offset ?? "0");
          const booksUser = getSubsonicUser(server, params);
          const albums = server.appContext.repository.listAlbums();
          const books = booksUser ? server.appContext.repository.listBooks(booksUser.id) : [];
          const albumTracks = new Map<string, TrackRecord[]>();

          for (const album of albums) {
            albumTracks.set(album.id, server.appContext.repository.listTracksByAlbum(album.id));
          }
          for (const book of books) {
            albumTracks.set(book.id, server.appContext.repository.listTracksByBook(book.id));
          }

          const sortedAlbums = [...albums, ...books.map((book) => asBookAlbum(book, albumTracks.get(book.id) ?? []))].sort((left, right) => {
            switch (type) {
              case "alphabeticalByArtist":
                return left.artist.localeCompare(right.artist) || left.name.localeCompare(right.name);
              case "newest":
              case "recent":
                return right.name.localeCompare(left.name);
              case "alphabeticalByName":
              default:
                return left.name.localeCompare(right.name) || left.artist.localeCompare(right.artist);
            }
          });

          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} getAlbumList2-debug type=${type} size=${size} offset=${offset} total=${sortedAlbums.length}\n`
          ).catch(() => undefined);

          return sendSubsonicResponse(reply, params, {
            albumList2: {
              album: sortedAlbums.slice(offset, offset + size).map((album) =>
                "songCount" in album && books.some((book) => book.id === album.id)
                  ? album
                  : asAlbum(album as AlbumRecord, albumTracks.get(album.id) ?? [])
              )
            }
          });
        }
        case "getAlbumList": {
          const type = params.type ?? "alphabeticalByName";
          const size = Number(params.size ?? "50");
          const offset = Number(params.offset ?? "0");
          const booksUser = getSubsonicUser(server, params);
          const albums = server.appContext.repository.listAlbums();
          const books = booksUser ? server.appContext.repository.listBooks(booksUser.id) : [];
          const albumTracks = new Map<string, TrackRecord[]>();

          for (const album of albums) {
            albumTracks.set(album.id, server.appContext.repository.listTracksByAlbum(album.id));
          }
          for (const book of books) {
            albumTracks.set(book.id, server.appContext.repository.listTracksByBook(book.id));
          }

          const sortedAlbums = [...albums, ...books.map((book) => asBookAlbum(book, albumTracks.get(book.id) ?? []))].sort((left, right) => {
            switch (type) {
              case "alphabeticalByArtist":
                return left.artist.localeCompare(right.artist) || left.name.localeCompare(right.name);
              case "newest":
              case "recent":
                return right.name.localeCompare(left.name);
              case "alphabeticalByName":
              default:
                return left.name.localeCompare(right.name) || left.artist.localeCompare(right.artist);
            }
          });

          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} getAlbumList-debug type=${type} size=${size} offset=${offset} total=${sortedAlbums.length}\n`
          ).catch(() => undefined);

          return sendSubsonicResponse(reply, params, {
            albumList: {
              album: sortedAlbums.slice(offset, offset + size).map((album) =>
                "songCount" in album && books.some((book) => book.id === album.id)
                  ? album
                  : asAlbum(album as AlbumRecord, albumTracks.get(album.id) ?? [])
              )
            }
          });
        }
        case "getGenres": {
          const genreMap = new Map<string, number>();

          for (const track of server.appContext.repository.listTracks()) {
            const genres = (track.genre ?? "")
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);

            for (const genre of genres) {
              genreMap.set(genre, (genreMap.get(genre) ?? 0) + 1);
            }
          }

          return sendSubsonicResponse(reply, params, {
            genres: {
              genre: [...genreMap.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([value, songCount]) => ({
                  value,
                  songCount,
                  albumCount: 0
                }))
            }
          });
        }
        case "getBookmarks": {
          const user = getSubsonicUser(server, params);
          const bookmarks = user ? server.appContext.repository.listAllBookBookmarks(user.id) : [];
          const entries = bookmarks
            .map((bookmark) => {
              const track = server.appContext.repository.getTrackById(bookmark.trackId);
              return track ? asSubsonicBookmark(bookmark, track) : null;
            })
            .filter(Boolean);

          return sendSubsonicResponse(reply, params, {
            bookmarks: {
              bookmark: entries
            }
          });
        }
        case "createBookmark": {
          const user = getSubsonicUser(server, params);
          const trackId = params.id;
          const track = trackId ? server.appContext.repository.getTrackById(trackId) : null;
          const position = Number.parseInt(params.position ?? "0", 10) || 0;

          if (!user || !track?.bookId) {
            return sendSubsonicResponse(reply, params, {});
          }

          server.appContext.repository.createBookBookmark(user.id, track.bookId, track.id, Math.floor(position / 1000), params.comment?.trim() || null);
          await persistBookStateSidecar(server.appContext.repository, track.bookId);
          return sendSubsonicResponse(reply, params, {});
        }
        case "deleteBookmark": {
          const user = getSubsonicUser(server, params);
          const bookmarkId = params.id;

          if (user && bookmarkId) {
            const bookmark = server.appContext.repository.getBookBookmarkById(user.id, bookmarkId);
            server.appContext.repository.deleteBookBookmark(user.id, bookmarkId);

            if (bookmark?.bookId) {
              await persistBookStateSidecar(server.appContext.repository, bookmark.bookId);
            }
          }

          return sendSubsonicResponse(reply, params, {});
        }
        case "getCoverArt": {
          const id = params.id;

          if (!id) {
            return sendSubsonicError(reply, params, 10, "Missing artwork id.");
          }

          const coverArt = server.appContext.repository.getCoverArtById(id);

          if (!coverArt) {
            return sendSubsonicError(reply, params, 70, "Cover art not found.", 404);
          }

          reply.header("Cache-Control", "no-store, max-age=0, must-revalidate");
          reply.header("Pragma", "no-cache");
          reply.header("Expires", "0");

          return reply.type(coverArt.mimeType).send(Buffer.from(coverArt.data));
        }
        case "getSong": {
          const trackId = params.id;
          const track = trackId ? server.appContext.repository.getTrackById(trackId) : null;

          if (!track) {
            return sendSubsonicError(reply, params, 70, "Track not found.", 404);
          }

          return sendSubsonicResponse(reply, params, {
            song: asChild(track, track.albumId)
          });
        }
        case "search3": {
          const query = normalizeSearchQuery(params.query).toLowerCase();
          const artists = server.appContext.repository.listArtists();
          const booksUser = getSubsonicUser(server, params);
          const albums = server.appContext.repository.listAlbums();
          const books = booksUser ? server.appContext.repository.listBooks(booksUser.id) : [];
          const tracks = server.appContext.repository.listTracks();

          const matchingArtists = artists.filter((artist) =>
            !query || artist.name.toLowerCase().includes(query)
          );
          const matchingAlbums = albums.filter((album) =>
            !query ||
            album.name.toLowerCase().includes(query) ||
            album.artist.toLowerCase().includes(query)
          );
          const matchingBooks = books.filter((book) =>
            !query ||
            book.title.toLowerCase().includes(query) ||
            book.author.toLowerCase().includes(query)
          );
          const matchingTracks = tracks.filter((track) => {
            if (!query) {
              return true;
            }

            return [
              track.title ?? "",
              track.artist ?? "",
              track.album ?? "",
              track.genre ?? ""
            ].some((value) => value.toLowerCase().includes(query));
          });

          const artistCount = Number.parseInt(params.artistCount ?? "0", 10) || 0;
          const albumCount = Number.parseInt(params.albumCount ?? "0", 10) || 0;
          const songCount = Number.parseInt(params.songCount ?? "0", 10) || 0;

          const artistResults = artistCount > 0
            ? sliceByOffsetCount(matchingArtists, params.artistOffset, params.artistCount).map(asArtist)
            : [];
          const albumResults = albumCount > 0
            ? [
                ...sliceByOffsetCount(matchingAlbums, params.albumOffset, params.albumCount).map((album) =>
                  asAlbum(album, server.appContext.repository.listTracksByAlbum(album.id))
                ),
                ...sliceByOffsetCount(matchingBooks, params.albumOffset, params.albumCount).map((book) =>
                  asBookAlbum(book, server.appContext.repository.listTracksByBook(book.id))
                )
              ].slice(0, albumCount)
            : [];
          const songResults = songCount > 0
            ? sliceByOffsetCount(matchingTracks, params.songOffset, params.songCount).map((track) => asChild(track, track.albumId))
            : [];
          const duplicateAlbumIds = matchingAlbums.length - new Set(matchingAlbums.map((album) => album.id)).size;

          const searchResult3: Record<string, unknown> = {
            artist: artistResults,
            album: albumResults,
            song: songResults
          };

          searchResult3.artistCount = matchingArtists.length;
          searchResult3.albumCount = matchingAlbums.length + matchingBooks.length;
          searchResult3.songCount = matchingTracks.length;

          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} search3-debug query=${JSON.stringify(params.query ?? "")} artistCount=${artistCount} albumCount=${albumCount} songCount=${songCount} artistResults=${artistResults.length} albumResults=${albumResults.length} songResults=${songResults.length} duplicateAlbumIds=${duplicateAlbumIds}\n`
          ).catch(() => undefined);

          return sendSubsonicResponse(reply, params, {
            searchResult3
          });
        }
        case "search2": {
          const query = normalizeSearchQuery(params.query).toLowerCase();
          const artists = server.appContext.repository.listArtists();
          const booksUser = getSubsonicUser(server, params);
          const albums = server.appContext.repository.listAlbums();
          const books = booksUser ? server.appContext.repository.listBooks(booksUser.id) : [];
          const tracks = server.appContext.repository.listTracks();
          const matchingArtists = artists.filter((artist) => !query || artist.name.toLowerCase().includes(query));
          const matchingAlbums = albums.filter((album) => !query || album.name.toLowerCase().includes(query) || album.artist.toLowerCase().includes(query));
          const matchingBooks = books.filter((book) => !query || book.title.toLowerCase().includes(query) || book.author.toLowerCase().includes(query));
          const matchingTracks = tracks.filter((track) => {
            if (!query) {
              return true;
            }

            return [track.title ?? "", track.artist ?? "", track.album ?? "", track.genre ?? ""].some((value) =>
              value.toLowerCase().includes(query)
            );
          });

          const artistCount = Number.parseInt(params.artistCount ?? "0", 10) || 0;
          const albumCount = Number.parseInt(params.albumCount ?? "0", 10) || 0;
          const songCount = Number.parseInt(params.songCount ?? "0", 10) || 0;

          const artistResults = artistCount > 0
            ? sliceByOffsetCount(matchingArtists, params.artistOffset, params.artistCount).map(asArtist)
            : [];
          const albumResults = albumCount > 0
            ? [
                ...sliceByOffsetCount(matchingAlbums, params.albumOffset, params.albumCount).map((album) =>
                  asAlbum(album, server.appContext.repository.listTracksByAlbum(album.id))
                ),
                ...sliceByOffsetCount(matchingBooks, params.albumOffset, params.albumCount).map((book) =>
                  asBookAlbum(book, server.appContext.repository.listTracksByBook(book.id))
                )
              ].slice(0, albumCount)
            : [];
          const songResults = songCount > 0
            ? sliceByOffsetCount(matchingTracks, params.songOffset, params.songCount).map((track) => asChild(track, track.albumId))
            : [];
          const duplicateAlbumIds = matchingAlbums.length - new Set(matchingAlbums.map((album) => album.id)).size;

          const searchResult2: Record<string, unknown> = {
            artist: artistResults,
            album: albumResults,
            song: songResults
          };

          searchResult2.artistCount = matchingArtists.length;
          searchResult2.albumCount = matchingAlbums.length + matchingBooks.length;
          searchResult2.songCount = matchingTracks.length;

          await appendFile(
            TEMP_REQUEST_LOG,
            `${new Date().toISOString()} search2-debug query=${JSON.stringify(params.query ?? "")} artistCount=${artistCount} albumCount=${albumCount} songCount=${songCount} artistResults=${artistResults.length} albumResults=${albumResults.length} songResults=${songResults.length} duplicateAlbumIds=${duplicateAlbumIds}\n`
          ).catch(() => undefined);

          return sendSubsonicResponse(reply, params, {
            searchResult2
          });
        }
        case "getPlaylists": {
          const user = getSubsonicUser(server, params);

          if (!user) {
            return sendSubsonicResponse(reply, params, {
              playlists: {
                playlist: []
              }
            });
          }

          return sendSubsonicResponse(reply, params, {
            playlists: {
              playlist: server.appContext.repository.listPlaylists(user.id).map((playlist) => asPlaylist(playlist, user.name))
            }
          });
        }
        case "getPlaylist": {
          const user = getSubsonicUser(server, params);

          if (!user) {
            return sendSubsonicError(reply, params, 70, "Playlist not found.", 404);
          }

          const playlistId = params.id;
          const playlist = playlistId ? server.appContext.repository.getPlaylistById(user.id, playlistId) : null;

          if (!playlist) {
            return sendSubsonicError(reply, params, 70, "Playlist not found.", 404);
          }

          return sendSubsonicResponse(reply, params, {
            playlist: {
              ...asPlaylist(playlist, user.name),
              entry: playlist.tracks.map((track) => asChild(track, track.albumId))
            }
          });
        }
        case "createPlaylist": {
          const user = getSubsonicUser(server, params);

          if (!user) {
            return sendSubsonicError(reply, params, 50, "No local user exists for playlist ownership.", 400);
          }

          const name = (params.name ?? "").trim();

          if (!name) {
            return sendSubsonicError(reply, params, 10, "Missing playlist name.");
          }

          const playlist = server.appContext.repository.createPlaylist(user.id, name);
          const songId = params.songId ?? params.id ?? "";

          if (songId) {
            const track = server.appContext.repository.getTrackById(songId);

            if (track) {
              server.appContext.repository.addTrackToPlaylist(playlist.id, track.id);
            }
          }

          return sendSubsonicResponse(reply, params, {
            playlist: {
              ...asPlaylist(
                {
                  ...playlist,
                  tracks: server.appContext.repository.getPlaylistById(user.id, playlist.id)?.tracks ?? []
                },
                user.name
              )
            }
          });
        }
        case "getStarred":
        case "getStarred2": {
          const user = getSubsonicUser(server, params);
          const likedTracks = user ? server.appContext.repository.listLikedTracks(user.id) : [];
          const key = endpoint === "getStarred2" ? "starred2" : "starred";

          return sendSubsonicResponse(reply, params, {
            [key]: {
              song: likedTracks.map((track) => ({
                ...asChild(track, track.albumId),
                starred: new Date().toISOString()
              }))
            }
          });
        }
        case "star": {
          const user = getSubsonicUser(server, params);

          if (!user) {
            return sendSubsonicError(reply, params, 50, "No local user exists for starring.", 400);
          }

          const trackId = params.id;
          const track = trackId ? server.appContext.repository.getTrackById(trackId) : null;

          if (!track) {
            return sendSubsonicError(reply, params, 70, "Track not found.", 404);
          }

          server.appContext.repository.likeTrack(user.id, track.id);
          return sendSubsonicResponse(reply, params, {});
        }
        case "unstar": {
          const user = getSubsonicUser(server, params);

          if (!user) {
            return sendSubsonicError(reply, params, 50, "No local user exists for starring.", 400);
          }

          const trackId = params.id;

          if (!trackId) {
            return sendSubsonicError(reply, params, 10, "Missing track id.");
          }

          server.appContext.repository.unlikeTrack(user.id, trackId);
          return sendSubsonicResponse(reply, params, {});
        }
        case "getScanStatus": {
          const status = server.appContext.scanner.getStatus();
          return sendSubsonicResponse(reply, params, {
            scanStatus: {
              scanning: status.isScanning,
              count: status.totalFiles
            }
          });
        }
        case "startScan": {
          const result = server.appContext.scanner.requestScan("manual");
          return sendSubsonicResponse(reply, params, {
            scanStatus: {
              scanning: true,
              count: server.appContext.scanner.getStatus().totalFiles,
              queued: result === "queued"
            }
          });
        }
        case "getUser": {
          const user = getSubsonicUser(server, params);
          const username = params.username ?? server.appContext.config.subsonic.username;

          if (!user) {
            return sendSubsonicError(reply, params, 70, "User not found.", 404);
          }

          return sendSubsonicResponse(reply, params, {
            user: {
              ...asUser(user),
              username
            }
          });
        }
        case "getUsers": {
          const users = server.appContext.repository.listUsers();
          return sendSubsonicResponse(reply, params, {
            users: {
              user: users.map((user) => asUser(user))
            }
          });
        }
        case "scrobble": {
          const user = getSubsonicUser(server, params);
          const trackId = params.id;
          const track = trackId ? server.appContext.repository.getTrackById(trackId) : null;

          if (!user || !track) {
            return sendSubsonicResponse(reply, params, {});
          }

          server.appContext.repository.recordTrackPlay(user.id, track.id, new Date().toISOString());
          return sendSubsonicResponse(reply, params, {});
        }
        case "getNowPlaying":
          return sendSubsonicResponse(reply, params, {
            nowPlaying: {
              entry: []
            }
          });
        case "getRandomSongs": {
          const size = Number(params.size ?? "50");
          const tracks = [...server.appContext.repository.listTracks()].sort(() => Math.random() - 0.5).slice(0, size);
          return sendSubsonicResponse(reply, params, {
            randomSongs: {
              song: tracks.map((track) => asChild(track, track.albumId))
            }
          });
        }
        case "getSongsByGenre": {
          const genre = (params.genre ?? "").trim().toLowerCase();
          const count = Number(params.count ?? "50");
          const offset = Number(params.offset ?? "0");
          const matchingTracks = server.appContext.repository
            .listTracks()
            .filter((track) =>
              !genre
                ? true
                : (track.genre ?? "")
                    .split(",")
                    .map((value) => value.trim().toLowerCase())
                    .includes(genre)
            );

          return sendSubsonicResponse(reply, params, {
            songsByGenre: {
              song: matchingTracks.slice(offset, offset + count).map((track) => asChild(track, track.albumId))
            }
          });
        }
        default:
          return sendSubsonicError(reply, params, 0, `Unsupported OpenSubsonic endpoint: ${endpoint}`, 404);
      }
    }
  });
};

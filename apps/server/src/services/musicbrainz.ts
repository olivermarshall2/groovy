type MusicBrainzReleaseInfo = {
  title: string | null;
  year: number | null;
  genre: string | null;
};

type DownloadedArtwork = {
  data: Uint8Array;
  mimeType: string;
  fileExtension: ".jpg" | ".png";
};

type MusicBrainzArtistInfo = {
  name: string | null;
  outline: string | null;
  genre: string | null;
};

type MusicBrainzReleaseSearchInfo = {
  releaseId: string | null;
  title: string | null;
  year: number | null;
  genre: string | null;
};

const MUSICBRAINZ_API_ROOT = "https://musicbrainz.org/ws/2";
const USER_AGENT = "mp3-platform/0.1.0 (local library scanner)";

const releaseCache = new Map<string, Promise<MusicBrainzReleaseInfo | null>>();
const artistCache = new Map<string, Promise<MusicBrainzArtistInfo | null>>();
const releaseArtCache = new Map<string, Promise<DownloadedArtwork | null>>();
const releaseSearchCache = new Map<string, Promise<MusicBrainzReleaseSearchInfo | null>>();
const artistSearchCache = new Map<string, Promise<MusicBrainzArtistInfo | null>>();

const joinTerms = (values: Array<string | null | undefined>) => {
  const unique = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique.join(", ") : null;
};

const parseYear = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
};

const extractNamedValues = (items: unknown) =>
  Array.isArray(items)
    ? (items as unknown[])
        .map((item) => (typeof item === "object" && item && "name" in item ? (item as { name?: unknown }).name : null))
        .filter((value: unknown): value is string => typeof value === "string")
    : [];

const fetchJson = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`MusicBrainz request failed with ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
};

const fetchBinary = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.5"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`MusicBrainz artwork request failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "image/jpeg";
  const fileExtension = contentType.includes("png") ? ".png" : ".jpg";

  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mimeType: contentType,
    fileExtension
  } satisfies DownloadedArtwork;
};

export const lookupMusicBrainzRelease = (releaseId: string | null) => {
  if (!releaseId) {
    return Promise.resolve(null);
  }

  const existing = releaseCache.get(releaseId);

  if (existing) {
    return existing;
  }

  const request = fetchJson(
    `${MUSICBRAINZ_API_ROOT}/release/${encodeURIComponent(releaseId)}?fmt=json&inc=genres+tags+artist-credits`
  )
    .then((payload) => {
      const genres = Array.isArray(payload.genres)
        ? payload.genres
            .map((genre) => (typeof genre === "object" && genre && "name" in genre ? genre.name : null))
            .filter((value: unknown): value is string => typeof value === "string")
        : [];
      const tags = Array.isArray(payload.tags)
        ? payload.tags
            .map((tag) => (typeof tag === "object" && tag && "name" in tag ? tag.name : null))
            .filter((value: unknown): value is string => typeof value === "string")
        : [];

      return {
        title: typeof payload.title === "string" ? payload.title : null,
        year: parseYear(payload.date),
        genre: joinTerms([...genres, ...tags])
      } satisfies MusicBrainzReleaseInfo;
    })
    .catch(() => null);

  releaseCache.set(releaseId, request);
  return request;
};

export const lookupMusicBrainzArtist = (artistId: string | null) => {
  if (!artistId) {
    return Promise.resolve(null);
  }

  const existing = artistCache.get(artistId);

  if (existing) {
    return existing;
  }

  const request = fetchJson(`${MUSICBRAINZ_API_ROOT}/artist/${encodeURIComponent(artistId)}?fmt=json&inc=genres+tags`)
    .then((payload) => {
      const genres = Array.isArray(payload.genres)
        ? payload.genres
            .map((genre) => (typeof genre === "object" && genre && "name" in genre ? genre.name : null))
            .filter((value: unknown): value is string => typeof value === "string")
        : [];
      const tags = Array.isArray(payload.tags)
        ? payload.tags
            .map((tag) => (typeof tag === "object" && tag && "name" in tag ? tag.name : null))
            .filter((value: unknown): value is string => typeof value === "string")
        : [];

      return {
        name: typeof payload.name === "string" ? payload.name : null,
        outline: typeof payload.disambiguation === "string" ? payload.disambiguation : null,
        genre: joinTerms([...genres, ...tags])
      } satisfies MusicBrainzArtistInfo;
    })
    .catch(() => null);

  artistCache.set(artistId, request);
  return request;
};

export const downloadMusicBrainzReleaseCoverArt = (releaseId: string | null) => {
  if (!releaseId) {
    return Promise.resolve(null);
  }

  const existing = releaseArtCache.get(releaseId);

  if (existing) {
    return existing;
  }

  const request = fetchBinary(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front-500.jpg`).catch(() => null);
  releaseArtCache.set(releaseId, request);
  return request;
};

export const searchMusicBrainzRelease = (artist: string | null, album: string | null) => {
  const normalizedArtist = artist?.trim().toLowerCase() ?? "";
  const normalizedAlbum = album?.trim().toLowerCase() ?? "";

  if (!normalizedArtist || !normalizedAlbum) {
    return Promise.resolve(null);
  }

  const cacheKey = `${normalizedArtist}::${normalizedAlbum}`;
  const existing = releaseSearchCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const query = `artist:"${artist}" AND release:"${album}"`;
  const request = fetchJson(
    `${MUSICBRAINZ_API_ROOT}/release/?fmt=json&inc=genres+tags+artist-credits&limit=1&query=${encodeURIComponent(query)}`
  )
    .then((payload) => {
      const releases = Array.isArray(payload.releases) ? payload.releases : [];
      const release = releases[0];

      if (!release || typeof release !== "object") {
        return null;
      }

      const genres = extractNamedValues(release.genres);
      const tags = extractNamedValues(release.tags);

      return {
        releaseId: typeof release.id === "string" ? release.id : null,
        title: typeof release.title === "string" ? release.title : null,
        year: parseYear(release.date),
        genre: joinTerms([...genres, ...tags])
      } satisfies MusicBrainzReleaseSearchInfo;
    })
    .catch(() => null);

  releaseSearchCache.set(cacheKey, request);
  return request;
};

export const searchMusicBrainzArtist = (artist: string | null) => {
  const normalizedArtist = artist?.trim().toLowerCase() ?? "";

  if (!normalizedArtist) {
    return Promise.resolve(null);
  }

  const existing = artistSearchCache.get(normalizedArtist);

  if (existing) {
    return existing;
  }

  const request = fetchJson(
    `${MUSICBRAINZ_API_ROOT}/artist/?fmt=json&inc=genres+tags&limit=1&query=${encodeURIComponent(`artist:"${artist}"`)}`
  )
    .then((payload) => {
      const artists = Array.isArray(payload.artists) ? payload.artists : [];
      const artistEntry = artists[0];

      if (!artistEntry || typeof artistEntry !== "object") {
        return null;
      }

      const genres = extractNamedValues(artistEntry.genres);
      const tags = extractNamedValues(artistEntry.tags);

      return {
        name: typeof artistEntry.name === "string" ? artistEntry.name : null,
        outline: typeof artistEntry.disambiguation === "string" ? artistEntry.disambiguation : null,
        genre: joinTerms([...genres, ...tags])
      } satisfies MusicBrainzArtistInfo;
    })
    .catch(() => null);

  artistSearchCache.set(normalizedArtist, request);
  return request;
};

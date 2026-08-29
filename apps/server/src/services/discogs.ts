type DiscogsSearchResult = {
  id: number;
  title: string | null;
  artist: string | null;
  year: number | null;
  country: string | null;
  label: string | null;
  format: string | null;
  thumbUrl: string | null;
  resourceUrl: string | null;
  score: number;
};

type DiscogsReleaseInfo = {
  title: string | null;
  artist: string | null;
  year: number | null;
  genre: string | null;
  notes: string | null;
  imageUrl: string | null;
};

type DiscogsArtistInfo = {
  name: string | null;
  profile: string | null;
  imageUrl: string | null;
};

type DiscogsLogger = {
  debug?: (data: Record<string, unknown>, message: string) => void;
  info?: (data: Record<string, unknown>, message: string) => void;
  warn?: (data: Record<string, unknown>, message: string) => void;
  error?: (data: Record<string, unknown>, message: string) => void;
};

export type DiscogsAuth = {
  userToken: string | null;
  consumerKey: string | null;
  consumerSecret: string | null;
};

export type DiscogsAlbumSearchFilters = {
  artist: string | null;
  albumArtist: string | null;
  year: number | null;
  genre: string | null;
};

const DISCOGS_API_ROOT = "https://api.discogs.com";
const USER_AGENT = "mp3-platform/0.1.0 (local library scanner)";

const releaseSearchCache = new Map<string, Promise<DiscogsSearchResult[]>>();
const artistSearchCache = new Map<string, Promise<Array<{ id: number; name: string | null; profile: string | null; thumbUrl: string | null; resourceUrl: string | null; score: number }>>>();
const releaseCache = new Map<string, Promise<DiscogsReleaseInfo | null>>();
const artistCache = new Map<string, Promise<DiscogsArtistInfo | null>>();
const artworkCache = new Map<string, Promise<{ data: Uint8Array; fileExtension: ".jpg" | ".png" } | null>>();

const normalize = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";

const compactSearchValue = (value: string) => value.replace(/[/&(),.-]+/g, " ").replace(/\s+/g, " ").trim();

const buildReleaseSearchQueries = (artist: string, album: string, filters: DiscogsAlbumSearchFilters | null) => {
  const compactAlbum = album.replace(/\s*\/\s*/g, " / ");
  const strippedAlbum = album.replace(/[/&(),.-]+/g, " ").replace(/\s+/g, " ").trim();
  const strippedArtist = artist.replace(/[/&(),.-]+/g, " ").replace(/\s+/g, " ").trim();
  const extraArtistTerms = [...new Set([artist, filters?.albumArtist, filters?.artist].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  const yearTerms = filters?.year ? [String(filters.year)] : [];
  const genreTerm = filters?.genre?.trim() ?? "";

  const buildQuery = (...parts: Array<string | null | undefined>) =>
    parts
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join(" ");

  const queries = new Set<string>();
  const albumTerms = [...new Set([album, compactAlbum, strippedAlbum].map((value) => value.trim()).filter((value) => Boolean(value)))];

  for (const albumTerm of albumTerms) {
    queries.add(`${DISCOGS_API_ROOT}/database/search?type=release&release_title=${encodeURIComponent(albumTerm)}&per_page=10&page=1`);
    queries.add(`${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(albumTerm)}&per_page=10&page=1`);

    for (const yearTerm of yearTerms) {
      queries.add(
        `${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(buildQuery(albumTerm, yearTerm, genreTerm))}&per_page=10&page=1`
      );
    }
  }

  for (const artistTerm of extraArtistTerms) {
    const strippedArtistTerm = compactSearchValue(artistTerm);

    for (const albumTerm of albumTerms) {
      queries.add(
        `${DISCOGS_API_ROOT}/database/search?type=release&artist=${encodeURIComponent(artistTerm)}&release_title=${encodeURIComponent(albumTerm)}&per_page=10&page=1`
      );
      queries.add(
        `${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(buildQuery(artistTerm, albumTerm))}&per_page=10&page=1`
      );
      queries.add(
        `${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(buildQuery(strippedArtistTerm, compactSearchValue(albumTerm)))}&per_page=10&page=1`
      );

      for (const yearTerm of yearTerms) {
        queries.add(
          `${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(buildQuery(artistTerm, albumTerm, yearTerm, genreTerm))}&per_page=10&page=1`
        );
        queries.add(
          `${DISCOGS_API_ROOT}/database/search?type=release&q=${encodeURIComponent(buildQuery(strippedArtistTerm, compactSearchValue(albumTerm), yearTerm, genreTerm))}&per_page=10&page=1`
        );
      }
    }
  }

  return [...queries];
};

const joinTerms = (values: Array<string | null | undefined>) => {
  const unique = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique.join(", ") : null;
};

const authCacheKey = (auth: DiscogsAuth) => auth.userToken ?? `${auth.consumerKey ?? ""}:${auth.consumerSecret ?? ""}`;

const parseYear = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
};

const getDiscogsHeaders = ({ userToken, consumerKey, consumerSecret }: DiscogsAuth) => {
  const headers: HeadersInit = {
    "User-Agent": USER_AGENT,
    Accept: "application/json"
  };

  if (userToken) {
    headers.Authorization = `Discogs token=${userToken}`;
  } else if (consumerKey && consumerSecret) {
    headers.Authorization = `Discogs key=${consumerKey}, secret=${consumerSecret}`;
  }

  return headers;
};

const fetchJson = async (url: string, auth: DiscogsAuth) => {
  const response = await fetch(url, {
    headers: getDiscogsHeaders(auth),
    signal: AbortSignal.timeout(7000)
  });

  if (!response.ok) {
    throw new Error(`Discogs request failed with ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
};

const fetchBinary = async (url: string, auth: DiscogsAuth) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.5",
      ...(auth.userToken
        ? { Authorization: `Discogs token=${auth.userToken}` }
        : auth.consumerKey && auth.consumerSecret
          ? { Authorization: `Discogs key=${auth.consumerKey}, secret=${auth.consumerSecret}` }
          : {})
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`Discogs artwork request failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "image/jpeg";
  const fileExtension: ".jpg" | ".png" = contentType.includes("png") ? ".png" : ".jpg";

  return {
    data: new Uint8Array(await response.arrayBuffer()),
    fileExtension
  };
};

export const downloadDiscogsArtwork = async (url: string | null, auth: DiscogsAuth) => {
  if (!url) {
    return null;
  }

  try {
    return await fetchBinary(url, auth);
  } catch {
    return null;
  }
};

const scoreSearchResult = (artist: string, album: string, result: Record<string, unknown>) => {
  const normalizedArtist = normalize(artist);
  const normalizedAlbum = normalize(album);
  const resultArtist = normalize(typeof result.artist === "string" ? result.artist : null);
  const resultTitle = normalize(typeof result.title === "string" ? result.title : null);

  let score = 0;

  if (resultArtist === normalizedArtist) {
    score += 4;
  } else if (resultArtist.includes(normalizedArtist) || normalizedArtist.includes(resultArtist)) {
    score += 2;
  }

  if (resultTitle.includes(normalizedAlbum)) {
    score += 3;
  }

  if (resultTitle === `${normalizedArtist} - ${normalizedAlbum}`) {
    score += 6;
  }

  if (typeof result.year === "number") {
    score += 1;
  }

  return score;
};

const mapReleaseSearchResult = (artist: string, album: string, result: Record<string, unknown>): DiscogsSearchResult | null => {
  if (typeof result.id !== "number") {
    return null;
  }

  return {
    id: result.id,
    title: typeof result.title === "string" ? result.title : null,
    artist: typeof result.artist === "string" ? result.artist : null,
    year: parseYear(result.year),
    country: typeof result.country === "string" ? result.country : null,
    label: Array.isArray(result.label) ? result.label.filter((value): value is string => typeof value === "string").join(", ") : null,
    format: Array.isArray(result.format) ? result.format.filter((value): value is string => typeof value === "string").join(", ") : null,
    thumbUrl: typeof result.thumb === "string" && result.thumb.trim().length > 0 ? result.thumb.trim() : null,
    resourceUrl: typeof result.resource_url === "string" ? result.resource_url : null,
    score: scoreSearchResult(artist, album, result)
  };
};

const mapArtistSearchResult = (artist: string, result: Record<string, unknown>) => {
  if (typeof result.id !== "number") {
    return null;
  }

  return {
    id: result.id,
    name: typeof result.title === "string" ? result.title : null,
    profile: typeof result.title === "string" ? result.title : null,
    thumbUrl: typeof result.thumb === "string" && result.thumb.trim().length > 0 ? result.thumb.trim() : null,
    resourceUrl: typeof result.resource_url === "string" ? result.resource_url : null,
    score: normalize(typeof result.title === "string" ? result.title : null).includes(normalize(artist)) ? 3 : 0
  };
};

export const searchDiscogsAlbumCandidates = async (
  artist: string | null,
  album: string | null,
  auth: DiscogsAuth,
  filters: DiscogsAlbumSearchFilters | null = null,
  logger?: DiscogsLogger
) => {
  const normalizedArtist = normalize(artist);
  const normalizedAlbum = normalize(album);

  if (!normalizedArtist || !normalizedAlbum) {
    return [];
  }

  const cacheKey = `${normalizedArtist}::${normalizedAlbum}::${filters?.artist ?? ""}::${filters?.albumArtist ?? ""}::${filters?.year ?? ""}::${filters?.genre ?? ""}::${authCacheKey(auth)}`;
  const existing = releaseSearchCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const request = (async () => {
    const combinedResults = new Map<number, DiscogsSearchResult>();
    let hadSuccessfulQuery = false;

    const queryFilters = filters ?? null;

    for (const queryUrl of buildReleaseSearchQueries(artist as string, album as string, queryFilters)) {
      try {
        const payload = await fetchJson(queryUrl, auth);
        hadSuccessfulQuery = true;
        const results = Array.isArray(payload.results) ? payload.results : [];
        logger?.debug?.(
          {
            queryUrl,
            resultCount: results.length,
            artist,
            album,
            filters: queryFilters
          },
          "Discogs album search query succeeded"
        );

        for (const result of results) {
          if (!result || typeof result !== "object") {
            continue;
          }

          const mapped = mapReleaseSearchResult(artist as string, album as string, result as Record<string, unknown>);

          if (mapped) {
            if (queryFilters?.year && mapped.year && mapped.year !== queryFilters.year) {
              mapped.score -= 1;
            }

            combinedResults.set(mapped.id, mapped);
          }
        }
      } catch (error) {
        logger?.warn?.(
          {
            queryUrl,
            error: error instanceof Error ? error.message : "Unknown error",
            artist,
            album,
            filters: queryFilters
          },
          "Discogs album search query failed"
        );
        continue;
      }
    }

    const sortedResults = [...combinedResults.values()].sort((left, right) => right.score - left.score || left.title?.localeCompare(right.title ?? "") || 0);

    if (!hadSuccessfulQuery && sortedResults.length === 0) {
      logger?.error?.(
        {
          artist,
          album,
          filters: queryFilters
        },
        "Discogs album search failed for every query"
      );
      releaseSearchCache.delete(cacheKey);
    }

    return sortedResults;
  })();

  releaseSearchCache.set(cacheKey, request);
  return request;
};

export const searchDiscogsArtistCandidates = async (artist: string | null, auth: DiscogsAuth) => {
  const normalizedArtist = normalize(artist);

  if (!normalizedArtist) {
    return [];
  }

  const cacheKey = `artist::${normalizedArtist}::${authCacheKey(auth)}`;
  const existing = artistSearchCache.get(cacheKey);

  if (existing) {
    return existing as Promise<Array<{ id: number; name: string | null; profile: string | null; thumbUrl: string | null; resourceUrl: string | null; score: number }>>;
  }

  const request = fetchJson(
    `${DISCOGS_API_ROOT}/database/search?type=artist&q=${encodeURIComponent(artist as string)}&per_page=10&page=1`,
    auth
  )
    .then((payload) => {
      const results = Array.isArray(payload.results) ? payload.results : [];
      return results
        .map((result) => (result && typeof result === "object" ? mapArtistSearchResult(artist as string, result as Record<string, unknown>) : null))
        .filter((result): result is { id: number; name: string | null; profile: string | null; thumbUrl: string | null; resourceUrl: string | null; score: number } => Boolean(result))
        .sort((left, right) => right.score - left.score || left.name?.localeCompare(right.name ?? "") || 0);
    })
    .catch(() => []);

  artistSearchCache.set(cacheKey, request);
  return request;
};

export const lookupDiscogsRelease = async (releaseId: number, auth: DiscogsAuth) => {
  const cacheId = `${releaseId}::${authCacheKey(auth)}`;
  const existing = releaseCache.get(cacheId);

  if (existing) {
    return existing;
  }

  const request = fetchJson(`${DISCOGS_API_ROOT}/releases/${releaseId}`, auth)
    .then((payload) => {
      const artists = Array.isArray(payload.artists)
        ? payload.artists
            .map((item) => (item && typeof item === "object" && "name" in item ? String(item.name) : null))
            .filter((value): value is string => Boolean(value))
        : [];
      const images = Array.isArray(payload.images) ? payload.images : [];
      const image = images.find((entry) => entry && typeof entry === "object" && typeof entry.uri === "string");

      return {
        title: typeof payload.title === "string" ? payload.title : null,
        artist: joinTerms(artists),
        year: parseYear(payload.year) ?? parseYear(payload.released),
        genre: joinTerms([
          ...(Array.isArray(payload.genres) ? payload.genres.filter((value): value is string => typeof value === "string") : []),
          ...(Array.isArray(payload.styles) ? payload.styles.filter((value): value is string => typeof value === "string") : [])
        ]),
        notes: typeof payload.notes === "string" && payload.notes.trim().length > 0 ? payload.notes.trim() : null,
        imageUrl: image && typeof image.uri === "string" ? image.uri : null
      } satisfies DiscogsReleaseInfo;
    })
    .catch(() => null)
    .then((result) => {
      if (!result) {
        releaseCache.delete(cacheId);
      }

      return result;
    });

  releaseCache.set(cacheId, request);
  return request;
};

export const lookupDiscogsArtist = async (artistId: number, auth: DiscogsAuth) => {
  const cacheId = `${artistId}::${authCacheKey(auth)}`;
  const existing = artistCache.get(cacheId);

  if (existing) {
    return existing;
  }

  const request = fetchJson(`${DISCOGS_API_ROOT}/artists/${artistId}`, auth)
    .then((payload) => {
      const images = Array.isArray(payload.images) ? payload.images : [];
      const image = images.find((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).uri === "string");

      return {
        name: typeof payload.name === "string" ? payload.name : null,
        profile: typeof payload.profile === "string" && payload.profile.trim().length > 0 ? payload.profile.trim() : null,
        imageUrl: image && typeof (image as Record<string, unknown>).uri === "string" ? String((image as Record<string, unknown>).uri) : null
      } satisfies DiscogsArtistInfo;
    })
    .catch(() => null)
    .then((result) => {
      if (!result) {
        artistCache.delete(cacheId);
      }

      return result;
    });

  artistCache.set(cacheId, request);
  return request;
};

export const downloadDiscogsReleaseCoverArt = async (releaseId: number, auth: DiscogsAuth) => {
  const cacheId = `${releaseId}::${authCacheKey(auth)}`;
  const existing = artworkCache.get(cacheId);

  if (existing) {
    return existing;
  }

  const request = lookupDiscogsRelease(releaseId, auth)
    .then(async (release) => {
      if (!release?.imageUrl) {
        return null;
      }

      const artwork = await downloadDiscogsArtwork(release.imageUrl, auth);
      if (!artwork) {
        return null;
      }

      return {
        data: artwork.data,
        fileExtension: artwork.fileExtension
      } as const;
    })
    .catch(() => null)
    .then((result) => {
      if (!result) {
        artworkCache.delete(cacheId);
      }

      return result;
    });

  artworkCache.set(cacheId, request);
  return request;
};

export const downloadDiscogsArtistCoverArt = async (artistId: number, auth: DiscogsAuth) => {
  const cacheId = `${artistId * -1}::${authCacheKey(auth)}`;
  const existing = artworkCache.get(cacheId);

  if (existing) {
    return existing;
  }

  const request = lookupDiscogsArtist(artistId, auth)
    .then(async (artist) => {
      if (!artist?.imageUrl) {
        return null;
      }

      const artwork = await downloadDiscogsArtwork(artist.imageUrl, auth);
      if (!artwork) {
        return null;
      }

      return {
        data: artwork.data,
        fileExtension: artwork.fileExtension
      } as const;
    })
    .catch(() => null)
    .then((result) => {
      if (!result) {
        artworkCache.delete(cacheId);
      }

      return result;
    });

  artworkCache.set(cacheId, request);
  return request;
};

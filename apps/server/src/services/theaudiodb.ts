const THE_AUDIO_DB_ROOT = "https://theaudiodb.com/api/v1/json/2";
const USER_AGENT = "mp3-platform/0.1.0 (local library scanner)";

const albumDescriptionCache = new Map<string, Promise<string | null>>();
const albumArtworkCache = new Map<string, Promise<string | null>>();
const artistArtworkCache = new Map<string, Promise<string | null>>();

const fetchJson = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`TheAudioDB request failed with ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
};

const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";

export const lookupTheAudioDbAlbumDescription = (artist: string | null, album: string | null) => {
  const normalizedArtist = normalize(artist);
  const normalizedAlbum = normalize(album);

  if (!normalizedArtist || !normalizedAlbum) {
    return Promise.resolve(null);
  }

  const cacheKey = `${normalizedArtist}::${normalizedAlbum}`;
  const existing = albumDescriptionCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const request = fetchJson(
    `${THE_AUDIO_DB_ROOT}/searchalbum.php?s=${encodeURIComponent(artist as string)}&a=${encodeURIComponent(album as string)}`
  )
    .then((payload) => {
      const albums = Array.isArray(payload.album) ? payload.album : [];
      const bestMatch = albums.find((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const albumName = "strAlbum" in entry ? normalize(String(entry.strAlbum)) : "";
        const artistName = "strArtist" in entry ? normalize(String(entry.strArtist)) : "";
        return albumName === normalizedAlbum && artistName === normalizedArtist;
      }) ?? albums[0];

      if (!bestMatch || typeof bestMatch !== "object") {
        return null;
      }

      return "strDescriptionEN" in bestMatch && typeof bestMatch.strDescriptionEN === "string" && bestMatch.strDescriptionEN.trim().length > 0
        ? bestMatch.strDescriptionEN.trim()
        : null;
    })
    .catch(() => null);

  albumDescriptionCache.set(cacheKey, request);
  return request;
};

export const lookupTheAudioDbAlbumArtwork = (artist: string | null, album: string | null) => {
  const normalizedArtist = normalize(artist);
  const normalizedAlbum = normalize(album);

  if (!normalizedArtist || !normalizedAlbum) {
    return Promise.resolve(null);
  }

  const cacheKey = `${normalizedArtist}::${normalizedAlbum}`;
  const existing = albumArtworkCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const request = fetchJson(
    `${THE_AUDIO_DB_ROOT}/searchalbum.php?s=${encodeURIComponent(artist as string)}&a=${encodeURIComponent(album as string)}`
  )
    .then((payload) => {
      const albums = Array.isArray(payload.album) ? payload.album : [];
      const bestMatch = albums.find((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const albumName = "strAlbum" in entry ? normalize(String(entry.strAlbum)) : "";
        const artistName = "strArtist" in entry ? normalize(String(entry.strArtist)) : "";
        return albumName === normalizedAlbum && artistName === normalizedArtist;
      }) ?? albums[0];

      if (!bestMatch || typeof bestMatch !== "object") {
        return null;
      }

      const artworkFields = ["strAlbumThumbHQ", "strAlbumThumb", "strAlbumCDart"];

      for (const field of artworkFields) {
        const value = field in bestMatch ? bestMatch[field as keyof typeof bestMatch] : null;

        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }

      return null;
    })
    .catch(() => null);

  albumArtworkCache.set(cacheKey, request);
  return request;
};

export const lookupTheAudioDbArtistArtwork = (artist: string | null) => {
  const normalizedArtist = normalize(artist);

  if (!normalizedArtist) {
    return Promise.resolve(null);
  }

  const existing = artistArtworkCache.get(normalizedArtist);

  if (existing) {
    return existing;
  }

  const request = fetchJson(`${THE_AUDIO_DB_ROOT}/search.php?s=${encodeURIComponent(artist as string)}`)
    .then((payload) => {
      const artists = Array.isArray(payload.artists) ? payload.artists : [];
      const bestMatch = artists.find((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const artistName = "strArtist" in entry ? normalize(String(entry.strArtist)) : "";
        return artistName === normalizedArtist;
      }) ?? artists[0];

      if (!bestMatch || typeof bestMatch !== "object") {
        return null;
      }

      const artworkFields = ["strArtistThumb", "strArtistCutout", "strArtistClearart", "strArtistLogo"];

      for (const field of artworkFields) {
        const value = field in bestMatch ? bestMatch[field as keyof typeof bestMatch] : null;

        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }

      return null;
    })
    .catch(() => null);

  artistArtworkCache.set(normalizedArtist, request);
  return request;
};

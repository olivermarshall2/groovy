import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AlbumDetailRecord, AlbumRecord, TrackRecord } from "@mp3-platform/shared";

const decodeXml = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");

const extractTag = (source: string, tagName: string) => {
  const match = source.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
};

const extractNumberTag = (source: string, tagName: string) => {
  const value = extractTag(source, tagName);

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readTextIfExists = async (filePath: string) => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

export const readAlbumDetailFromNfo = async (album: AlbumRecord, tracks: TrackRecord[]): Promise<AlbumDetailRecord> => {
  const firstTrack = tracks[0];
  const albumFolder = firstTrack ? path.dirname(firstTrack.filePath) : null;

  const albumNfo = albumFolder ? await readTextIfExists(path.join(albumFolder, "album.nfo")) : null;
  const artistNfo = albumFolder ? await readTextIfExists(path.join(albumFolder, "artist.nfo")) : null;

  return {
    album,
    tracks,
    year: extractNumberTag(albumNfo ?? "", "year") ?? tracks.find((track) => track.year)?.year ?? null,
    genre: extractTag(albumNfo ?? "", "genre") ?? tracks.find((track) => track.genre)?.genre ?? null,
    review: extractTag(albumNfo ?? "", "review"),
    outline: extractTag(albumNfo ?? "", "outline"),
    artistBiography: extractTag(artistNfo ?? "", "biography"),
    artistOutline: extractTag(artistNfo ?? "", "outline"),
    artistFolderTitle: extractTag(artistNfo ?? "", "title")
  };
};

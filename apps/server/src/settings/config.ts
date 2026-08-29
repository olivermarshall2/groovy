import path from "node:path";
import { z } from "zod";
import { loadDotEnv } from "./env.js";

loadDotEnv();

const envSchema = z.object({
  SCAN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  DATABASE_PATH: z.string().default(path.join(process.cwd(), "apps", "server", "data", "library.db")),
  MUSIC_LIBRARY_ROOTS: z.string().trim().optional().default(""),
  AUDIOBOOK_LIBRARY_ROOTS: z.string().trim().optional().default(""),
  SUBSONIC_USERNAME: z.string().default("symfonium"),
  SUBSONIC_PASSWORD: z.string().default("change-me"),
  SUBSONIC_API_KEY: z.string().default("change-me"),
  DISCOGS_USER_TOKEN: z.string().trim().optional().default(""),
  DISCOGS_CONSUMER_KEY: z.string().trim().optional().default(""),
  DISCOGS_CONSUMER_SECRET: z.string().trim().optional().default("")
});

export type AppConfig = {
  databasePath: string;
  defaultScanIntervalMinutes: number;
  defaultLibraryRoots: string[];
  defaultBookRoots: string[];
  subsonic: {
    username: string;
    password: string;
    apiKey: string;
  };
  discogs: {
    userToken: string | null;
    consumerKey: string | null;
    consumerSecret: string | null;
  };
};

const parsePathList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const createConfig = (): AppConfig => {
  const env = envSchema.parse(process.env);

  return {
    databasePath: env.DATABASE_PATH,
    defaultScanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
    defaultLibraryRoots: parsePathList(env.MUSIC_LIBRARY_ROOTS),
    defaultBookRoots: parsePathList(env.AUDIOBOOK_LIBRARY_ROOTS),
    subsonic: {
      username: env.SUBSONIC_USERNAME,
      password: env.SUBSONIC_PASSWORD,
      apiKey: env.SUBSONIC_API_KEY
    },
    discogs: {
      userToken: env.DISCOGS_USER_TOKEN.trim() ? env.DISCOGS_USER_TOKEN.trim() : null,
      consumerKey: env.DISCOGS_CONSUMER_KEY.trim() ? env.DISCOGS_CONSUMER_KEY.trim() : null,
      consumerSecret: env.DISCOGS_CONSUMER_SECRET.trim() ? env.DISCOGS_CONSUMER_SECRET.trim() : null
    }
  };
};

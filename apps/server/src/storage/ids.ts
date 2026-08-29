import { createHash } from "node:crypto";
import path from "node:path";

const toPosixPath = (input: string) => input.replaceAll("\\", "/");

export const normalizeMediaPath = (filePath: string) =>
  toPosixPath(path.resolve(filePath)).toLowerCase();

export const createStableId = (prefix: string, value: string) => {
  const digest = createHash("sha1").update(value).digest("hex");
  return `${prefix}:${digest}`;
};


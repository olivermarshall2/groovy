const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

export const normalizeGenreLabel = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }

  const collapsed = collapseWhitespace(value);

  if (!collapsed) {
    return null;
  }

  const lowerCased = collapsed.toLocaleLowerCase();
  return `${lowerCased.charAt(0).toLocaleUpperCase()}${lowerCased.slice(1)}`;
};

export const splitGenreLabels = (value: string | null | undefined) => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => normalizeGenreLabel(part))
    .filter((part): part is string => Boolean(part));
};

export const normalizeGenreLabels = (values: Array<string | null | undefined>) => {
  const deduped = new Map<string, string>();

  for (const value of values) {
    for (const label of splitGenreLabels(value)) {
      const key = label.toLocaleLowerCase();

      if (!deduped.has(key)) {
        deduped.set(key, label);
      }
    }
  }

  return [...deduped.values()];
};

export const normalizeGenreValue = (value: string | null | undefined) => {
  const labels = normalizeGenreLabels([value]);
  return labels.length > 0 ? labels.join(", ") : null;
};

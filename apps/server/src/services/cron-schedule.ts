const CRON_FIELD_LIMITS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 }
] as const;

const matchesPart = (value: number, part: string, min: number, max: number) => {
  for (const item of part.split(",")) {
    const [rangePart, stepPart] = item.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);

    if (!Number.isInteger(step) || step < 1 || (item.split("/").length > 2)) {
      return false;
    }

    const [startText, endText] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      return false;
    }

    if (value >= start && value <= end && (value - start) % step === 0) {
      return true;
    }
  }

  return false;
};

export const isValidCronExpression = (expression: string) => {
  const parts = expression.trim().split(/\s+/);

  return parts.length === 5 && parts.every((part, index) => {
    const { min, max } = CRON_FIELD_LIMITS[index]!;
    return matchesPart(min, part, min, max) || matchesPart(max, part, min, max) || part.split(",").every((item) => {
      const [rangePart, stepPart] = item.split("/");
      const step = stepPart === undefined ? 1 : Number(stepPart);
      const [startText, endText] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
      const start = Number(startText);
      const end = endText === undefined ? start : Number(endText);
      return item.split("/").length <= 2 && Number.isInteger(step) && step > 0 && Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
    });
  });
};

export const cronMatches = (expression: string, now = new Date()) => {
  if (!isValidCronExpression(expression)) {
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
  const values = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];

  return [minute, hour, dayOfMonth, month, dayOfWeek].every((part, index) => {
    const { min, max } = CRON_FIELD_LIMITS[index]!;
    return matchesPart(values[index]!, part!, min, max) || (index === 4 && values[index] === 0 && matchesPart(7, part!, min, max));
  });
};

export const getCronMinuteKey = (now = new Date()) => `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

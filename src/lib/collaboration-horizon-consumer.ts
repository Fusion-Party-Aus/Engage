/**
 * The contract a Horizon consumer can rely on.
 *
 * This is deliberately consumer-side: it validates what Engage promises, not
 * what its own code happens to emit. The smoke poller and the tests use it.
 */

export const FORBIDDEN_FEED_KEYS = [
  "email",
  "contactAllowed",
  "internalNotes",
  "manageTokenHash",
  "claimedByMemberId",
  "memberId",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDateString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Key names anywhere in the payload that must never be present. */
export function forbiddenFeedKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => forbiddenFeedKeys(entry, `${path}[${index}]`));
  }
  if (!isObject(value)) return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if ((FORBIDDEN_FEED_KEYS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
    }
    found.push(...forbiddenFeedKeys(entry, `${path}.${key}`));
  }
  return found;
}

/** Every contract violation, or an empty list. */
export function horizonFeedErrors(payload: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(payload)) return ["The feed is not a JSON object."];
  if (!isDateString(payload.generatedAt)) errors.push("generatedAt is not a date.");
  if (payload.since !== null && !isDateString(payload.since)) errors.push("since is not null or a date.");
  if (payload.nextSince !== null && !isDateString(payload.nextSince)) {
    errors.push("nextSince is not null or a date.");
  }
  if (!Array.isArray(payload.stories)) {
    return [...errors, "stories is not an array."];
  }
  const ids = new Set<string>();
  payload.stories.forEach((story, index) => {
    const at = `stories[${index}]`;
    if (!isObject(story)) {
      errors.push(`${at} is not an object.`);
      return;
    }
    if (typeof story.id !== "string" || !story.id) errors.push(`${at}.id is missing.`);
    else if (ids.has(story.id)) errors.push(`${at}.id is duplicated.`);
    else ids.add(story.id);
    if (!isDateString(story.publishedAt)) errors.push(`${at}.publishedAt is not a date.`);
    if (story.attribution !== "named" && story.attribution !== "anonymous") {
      errors.push(`${at}.attribution is invalid.`);
    }
    if (typeof story.name !== "string") errors.push(`${at}.name is not text.`);
    if (story.attribution === "named" && typeof story.name === "string" && !story.name.trim()) {
      errors.push(`${at} is named but has no name.`);
    }
    if (story.attribution === "anonymous" && story.name !== "") {
      errors.push(`${at} is anonymous but carries a name.`);
    }
    if (!Array.isArray(story.answers)) {
      errors.push(`${at}.answers is not an array.`);
    } else {
      story.answers.forEach((answer, answerIndex) => {
        if (!isObject(answer) || typeof answer.label !== "string" || typeof answer.text !== "string") {
          errors.push(`${at}.answers[${answerIndex}] is invalid.`);
        }
      });
    }
    if (typeof story.caption !== "string") errors.push(`${at}.caption is not text.`);
    if (!Array.isArray(story.channels) || !story.channels.includes("website")) {
      errors.push(`${at}.channels does not include website.`);
    }
    if (!Array.isArray(story.media)) {
      errors.push(`${at}.media is not an array.`);
    } else {
      story.media.forEach((media, mediaIndex) => {
        if (!isObject(media)) {
          errors.push(`${at}.media[${mediaIndex}] is invalid.`);
          return;
        }
        if (!isHttpUrl(media.url)) {
          errors.push(`${at}.media[${mediaIndex}].url is not an http URL.`);
        }
        if (typeof media.mimeType !== "string" || !media.mimeType.startsWith("image/")) {
          errors.push(`${at}.media[${mediaIndex}].mimeType is not an image.`);
        }
        if (typeof media.alt !== "string" || !media.alt.trim()) {
          errors.push(`${at}.media[${mediaIndex}].alt is empty.`);
        }
      });
    }
    if (!isObject(story.editorial)) {
      errors.push(`${at}.editorial is missing.`);
    } else {
      if (typeof story.editorial.consentVersion !== "string" || !story.editorial.consentVersion) {
        errors.push(`${at}.editorial.consentVersion is missing.`);
      }
      if (typeof story.editorial.allowEdits !== "boolean") {
        errors.push(`${at}.editorial.allowEdits is not boolean.`);
      }
      if (typeof story.editorial.allowAiEdits !== "boolean") {
        errors.push(`${at}.editorial.allowAiEdits is not boolean.`);
      }
    }
  });
  for (const key of forbiddenFeedKeys(payload)) {
    errors.push(`Forbidden key present: ${key}`);
  }
  return errors;
}

const editableRoundFields = new Set(["opensAt", "closesAt"]);
const editableBallotFields = new Set(["opensAt", "closesAt", "policyRevisionId", "priority"]);

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function scheduleFields(input, current, now) {
  const opensAt = input.opensAt === undefined ? current.opensAt : parseDate(input.opensAt);
  const closesAt = input.closesAt === undefined ? current.closesAt : parseDate(input.closesAt);
  if (!(opensAt instanceof Date) || !(closesAt instanceof Date) || Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) {
    return { error: "Provide valid opening and closing dates." };
  }
  if ((input.opensAt !== undefined || input.closesAt !== undefined) && (opensAt < now || closesAt < now)) {
    return { error: "A draft schedule must use future opening and closing times." };
  }
  if (closesAt <= opensAt) return { error: "The closing time must be after the opening time." };
  return { opensAt, closesAt };
}

export function validateOpenBallotSchedule(input = {}, current = {}, now = new Date()) {
  const opensAt = input.opensAt === undefined
    ? (current.opensAt instanceof Date ? current.opensAt : parseDate(String(current.opensAt ?? "")))
    : parseDate(input.opensAt);
  const closesAt = input.closesAt === undefined
    ? (current.closesAt instanceof Date ? current.closesAt : parseDate(String(current.closesAt ?? "")))
    : parseDate(input.closesAt);
  if (!(opensAt instanceof Date) || !(closesAt instanceof Date) || Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) {
    return { error: "Configure valid opening and closing dates before opening the ballot." };
  }
  if (closesAt <= opensAt) {
    return { error: "The closing time must be after the opening time." };
  }
  if (closesAt <= now) {
    return { error: "Cannot open an expired ballot. Configure a valid voting window with a future closing time." };
  }
  if (opensAt > now) {
    return { error: "Cannot open a ballot before its configured opening time. Configure an active voting window that starts at or before the current time and closes in the future." };
  }
  return { opensAt, closesAt };
}

function hasOnly(input, allowed) {
  return Object.keys(input).length > 0 && Object.keys(input).every((key) => allowed.has(key));
}

export function validateDraftRoundPatch(input, current, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !hasOnly(input, editableRoundFields)) return { error: "Only opening and closing dates can be changed on a draft consultation round." };
  return scheduleFields(input, current, now);
}

export function validateDraftBallotPatch(input, current, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !hasOnly(input, editableBallotFields)) return { error: "Only policy version, schedule, and priority can be changed on a draft ballot." };
  const schedule = scheduleFields(input, current, now);
  if (schedule.error) return schedule;
  if (input.policyRevisionId !== undefined && (typeof input.policyRevisionId !== "string" || !input.policyRevisionId.trim() || input.policyRevisionId.length > 120)) return { error: "Choose a valid immutable policy revision." };
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 999)) return { error: "Priority must be a whole number from 0 to 999." };
  return {
    ...schedule,
    ...(input.policyRevisionId === undefined ? {} : { policyRevisionId: input.policyRevisionId }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
}

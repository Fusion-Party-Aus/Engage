/**
 * Block-anchored amendment suggestions.
 *
 * An amendment is still stored as whole-field replacement `changes`, because
 * that is what the ballot and apply path bind. Suggestions are the member-facing
 * editing model: each one names a stable block in the base revision, quotes the
 * original text and offers replacement, removal or addition. The server
 * reconstructs the complete wording from the quoted blocks, so a suggestion can
 * never silently replace text the member did not see.
 *
 * Anchors are block-level rather than character ranges. A paragraph or a single
 * commitment is the smallest unit a proposal actually publishes, and it gives
 * reconciliation a stable target when earlier wording changes.
 */

export const WORDING_FIELDS = ['title', 'summary', 'details', 'outcomes'] as const;
export type WordingField = (typeof WORDING_FIELDS)[number];

export interface WordingSnapshot {
  title: string;
  summary: string;
  outcomes: string[];
  details: string;
}

export interface WordingBlock {
  /** Stable within a revision: `${field}:${index}`. */
  blockId: string;
  field: WordingField;
  index: number;
  label: string;
  value: string;
}

export type SuggestionMode = 'replace' | 'remove' | 'add';

export interface AmendmentSuggestion {
  suggestionId: string;
  field: WordingField;
  index: number;
  original: string;
  proposed: string;
  comment?: string;
  mode: SuggestionMode;
}

export interface SuggestionClassification {
  suggestionId: string;
  state: 'clean' | 'moved' | 'conflict';
  /** Block index in the latest revision when the anchor still exists. */
  index?: number;
}

export interface RebaseResult {
  suggestions: AmendmentSuggestion[];
  changes: Partial<WordingSnapshot>;
  unresolved: string[];
  classifications: SuggestionClassification[];
}

export function wordingSnapshot(value: Record<string, any>): WordingSnapshot {
  return {
    title: String(value.title ?? ''),
    summary: String(value.summary ?? ''),
    outcomes: Array.isArray(value.outcomes) ? value.outcomes.map(String) : [],
    details: String(value.details ?? ''),
  };
}

/** Split prose into published blocks: blank-line paragraphs. */
export function paragraphs(value: string): string[] {
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  return trimmed ? trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean) : [];
}

export function wordingBlocks(snapshot: WordingSnapshot): WordingBlock[] {
  const blocks: WordingBlock[] = [
    { blockId: 'title:0', field: 'title', index: 0, label: 'Title', value: snapshot.title },
  ];
  paragraphs(snapshot.summary).forEach((value, index) => {
    blocks.push({
      blockId: `summary:${index}`,
      field: 'summary',
      index,
      label: paragraphs(snapshot.summary).length > 1 ? `Summary · paragraph ${index + 1}` : 'Summary',
      value,
    });
  });
  snapshot.outcomes.forEach((value, index) => {
    blocks.push({
      blockId: `outcomes:${index}`,
      field: 'outcomes',
      index,
      label: `Commitment ${index + 1}`,
      value,
    });
  });
  paragraphs(snapshot.details).forEach((value, index) => {
    blocks.push({
      blockId: `details:${index}`,
      field: 'details',
      index,
      label: paragraphs(snapshot.details).length > 1 ? `Rationale · paragraph ${index + 1}` : 'Rationale',
      value,
    });
  });
  return blocks;
}

function modeFor(original: string, proposed: string): SuggestionMode {
  if (!original) return 'add';
  if (!proposed) return 'remove';
  return 'replace';
}

const MAX_SUGGESTIONS = 40;
const MAX_BLOCK = 5000;

/**
 * Validate and normalise untrusted client input. The server generates the
 * suggestion ID; a client cannot use it to address another record.
 */
export function normalizeSuggestions(raw: unknown): AmendmentSuggestion[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Add at least one suggested change.');
  if (raw.length > MAX_SUGGESTIONS) throw new Error(`An amendment can include at most ${MAX_SUGGESTIONS} suggestions.`);
  const seen = new Set<string>();
  return raw.map((entry, ordinal) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`Suggestion ${ordinal + 1} is not valid.`);
    const value = entry as Record<string, unknown>;
    const field = value.field;
    if (typeof field !== 'string' || !WORDING_FIELDS.includes(field as WordingField))
      throw new Error(`Suggestion ${ordinal + 1} has an unsupported field.`);
    const index = Number(value.index);
    if (!Number.isSafeInteger(index) || index < 0 || index > 500)
      throw new Error(`Suggestion ${ordinal + 1} has an invalid block.`);
    const original = typeof value.original === 'string' ? value.original.trim() : '';
    const proposed = typeof value.proposed === 'string' ? value.proposed.trim() : '';
    const comment = typeof value.comment === 'string' ? value.comment.trim().slice(0, 500) : '';
    if (!original && !proposed)
      throw new Error(`Suggestion ${ordinal + 1} does not change anything.`);
    if (original.length > MAX_BLOCK || proposed.length > MAX_BLOCK)
      throw new Error(`Suggestion ${ordinal + 1} is too long.`);
    if (field === 'title' && (!original || !proposed))
      throw new Error('A title suggestion must replace the existing title.');
    const key = `${field}:${index}`;
    if (seen.has(key)) throw new Error('Only one suggestion can target the same block.');
    seen.add(key);
    return {
      suggestionId: `sug-${globalThis.crypto.randomUUID()}`,
      field: field as WordingField,
      index,
      original,
      proposed,
      ...(comment ? { comment } : {}),
      mode: modeFor(original, proposed),
    };
  });
}

function cloneSnapshot(snapshot: WordingSnapshot): WordingSnapshot {
  return {
    title: snapshot.title,
    summary: snapshot.summary,
    outcomes: [...snapshot.outcomes],
    details: snapshot.details,
  };
}

function proseSlot(snapshot: WordingSnapshot, field: 'summary' | 'details') {
  return paragraphs(snapshot[field]);
}

function setProse(snapshot: WordingSnapshot, field: 'summary' | 'details', parts: string[]) {
  snapshot[field] = parts.join('\n\n');
}

function applyOne(
  snapshot: WordingSnapshot,
  suggestion: AmendmentSuggestion,
  strict: boolean,
): string | null {
  const { field, index, original, proposed, mode } = suggestion;

  if (field === 'title') {
    if (snapshot.title !== original) return 'title';
    snapshot.title = proposed;
    return null;
  }

  if (field === 'outcomes') {
    const current = snapshot.outcomes[index];
    if (mode === 'add') {
      if (index > snapshot.outcomes.length) return 'outcomes';
      snapshot.outcomes.splice(index, 0, proposed);
      return null;
    }
    if (strict && current !== original) return 'outcomes';
    if (mode === 'remove') snapshot.outcomes.splice(index, 1);
    else snapshot.outcomes[index] = proposed;
    return null;
  }

  const parts = proseSlot(snapshot, field);
  if (mode === 'add') {
    if (index > parts.length) return field;
    parts.splice(index, 0, proposed);
    setProse(snapshot, field, parts);
    return null;
  }
  if (strict && parts[index] !== original) return field;
  if (mode === 'remove') parts.splice(index, 1);
  else parts[index] = proposed;
  setProse(snapshot, field, parts);
  return null;
}

/**
 * Apply suggestions to a snapshot. `strict` requires every quoted original to
 * match its anchor; rebasing uses non-strict application after anchors move.
 */
export function applySuggestions(
  base: WordingSnapshot,
  suggestions: AmendmentSuggestion[],
  options: { strict?: boolean } = {},
): { changes: Partial<WordingSnapshot>; unresolved: string[] } {
  const snapshot = cloneSnapshot(base);
  const touched = new Set<WordingField>();
  const unresolved: string[] = [];
  const fieldOrder: Record<WordingField, number> = { title: 0, summary: 1, outcomes: 2, details: 3 };
  const ordered = [...suggestions].sort((a, b) => {
    if (a.field !== b.field) return fieldOrder[a.field] - fieldOrder[b.field];
    if ((a.mode === 'add') !== (b.mode === 'add')) return a.mode === 'add' ? 1 : -1;
    return b.index - a.index;
  });
  for (const suggestion of ordered) {
    const failure = applyOne(snapshot, suggestion, options.strict !== false);
    if (failure) {
      if (!unresolved.includes(failure)) unresolved.push(failure);
      continue;
    }
    touched.add(suggestion.field);
  }
  // Sort additions descending so multiple inserts at the same block keep the
  // order the member wrote them in.
  const changes: Partial<WordingSnapshot> = {};
  for (const field of touched) {
    if (field === 'title') changes.title = snapshot.title;
    else if (field === 'summary') changes.summary = snapshot.summary;
    else if (field === 'details') changes.details = snapshot.details;
    else changes.outcomes = snapshot.outcomes;
  }
  return { changes, unresolved };
}

function locateOriginal(snapshot: WordingSnapshot, suggestion: AmendmentSuggestion): number[] {
  if (suggestion.field === 'title') return snapshot.title === suggestion.original ? [0] : [];
  if (suggestion.field === 'outcomes') {
    return snapshot.outcomes.flatMap((value, index) => value === suggestion.original ? [index] : []);
  }
  return paragraphs(snapshot[suggestion.field]).flatMap((value, index) => value === suggestion.original ? [index] : []);
}

export function classifySuggestions(
  base: WordingSnapshot,
  latest: WordingSnapshot,
  suggestions: AmendmentSuggestion[],
): SuggestionClassification[] {
  return suggestions.map((suggestion) => {
    if (suggestion.mode === 'add') {
      const length = suggestion.field === 'outcomes'
        ? latest.outcomes.length
        : suggestion.field === 'title'
          ? 1
          : paragraphs(latest[suggestion.field]).length;
      return {
        suggestionId: suggestion.suggestionId,
        state: suggestion.index <= length ? 'clean' : 'conflict',
        index: Math.min(suggestion.index, length),
      };
    }
    const latestMatches = locateOriginal(latest, suggestion);
    if (latestMatches.length === 0) {
      return { suggestionId: suggestion.suggestionId, state: 'conflict' };
    }
    const sameIndex = latestMatches.includes(suggestion.index);
    return {
      suggestionId: suggestion.suggestionId,
      state: sameIndex ? 'clean' : 'moved',
      index: sameIndex ? suggestion.index : latestMatches[0],
    };
  });
}

/** Move each anchor onto matching text in the latest revision. */
export function rebaseSuggestions(
  suggestions: AmendmentSuggestion[],
  latest: WordingSnapshot,
): RebaseResult {
  const rebased: AmendmentSuggestion[] = [];
  const unresolved: string[] = [];
  const classifications: SuggestionClassification[] = [];
  for (const suggestion of suggestions) {
    if (suggestion.mode === 'add') {
      const length = suggestion.field === 'outcomes'
        ? latest.outcomes.length
        : suggestion.field === 'title'
          ? 1
          : paragraphs(latest[suggestion.field]).length;
      const index = Math.min(suggestion.index, length);
      rebased.push({ ...suggestion, index });
      classifications.push({ suggestionId: suggestion.suggestionId, state: 'clean', index });
      continue;
    }
    const matches = locateOriginal(latest, suggestion);
    if (matches.length === 0) {
      unresolved.push(suggestion.field);
      classifications.push({ suggestionId: suggestion.suggestionId, state: 'conflict' });
      continue;
    }
    const index = matches.includes(suggestion.index) ? suggestion.index : matches[0]!;
    rebased.push({ ...suggestion, index });
    classifications.push({
      suggestionId: suggestion.suggestionId,
      state: index === suggestion.index ? 'clean' : 'moved',
      index,
    });
  }
  const applied = applySuggestions(latest, rebased, { strict: true });
  for (const field of applied.unresolved) if (!unresolved.includes(field)) unresolved.push(field);
  return { suggestions: rebased, changes: applied.changes, unresolved, classifications };
}

/**
 * The blocks an amendment intends to change. Two non-rejected amendments that
 * share a key are competing even when their replacement text differs.
 */
export function suggestionTargets(suggestions: AmendmentSuggestion[] | undefined): Set<string> {
  if (!suggestions?.length) return new Set();
  return new Set(suggestions.map((suggestion) => `${suggestion.field}:${suggestion.index}`));
}

export function competingTargets(
  suggestions: AmendmentSuggestion[] | undefined,
  otherSuggestions: AmendmentSuggestion[] | undefined,
): string[] {
  const ours = suggestionTargets(suggestions);
  const theirs = suggestionTargets(otherSuggestions);
  return [...ours].filter((key) => theirs.has(key));
}

export interface DiffSegment {
  type: 'same' | 'add' | 'remove';
  text: string;
}

/**
 * Word-level diff for display only. It never feeds the stored wording. The
 * token cap keeps an adversarial paragraph from making the page quadratic.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const tokenize = (value: string) => value.split(/(\s+)/).filter((part) => part.length > 0);
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length * right.length > 80_000) {
    return [
      ...(before ? [{ type: 'remove' as const, text: before }] : []),
      ...(after ? [{ type: 'add' as const, text: after }] : []),
    ];
  }
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = left[i] === right[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const segments: DiffSegment[] = [];
  const push = (type: DiffSegment['type'], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push('same', left[i]!);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('remove', left[i]!);
      i += 1;
    } else {
      push('add', right[j]!);
      j += 1;
    }
  }
  while (i < left.length) push('remove', left[i++]!);
  while (j < right.length) push('add', right[j++]!);
  return segments;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amendmentsCompete,
  anchorSuggestions,
  applySuggestions,
  classifySuggestions,
  competingTargets,
  diffWords,
  normalizeSuggestions,
  paragraphs,
  rebaseSuggestions,
  validateWordingChanges,
  wordingBlocks,
  wordingSnapshot,
  type AmendmentSuggestion,
} from './amendment-suggestions.ts';

const base = wordingSnapshot({
  title: 'Better regional trains',
  summary: 'Trains are infrequent.\n\nConnections are poor.',
  outcomes: ['Run more services', 'Improve connections'],
  details: 'The current timetable does not meet demand.\n\nRural towns are isolated.',
});

function suggestion(overrides: Partial<AmendmentSuggestion>): AmendmentSuggestion {
  return {
    suggestionId: 'sug-1',
    field: 'summary',
    index: 0,
    original: '',
    proposed: '',
    mode: 'replace',
    ...overrides,
  };
}

test('wording blocks give every published block a stable anchor', () => {
  const blocks = wordingBlocks(base);
  assert.deepEqual(blocks.map((block) => block.blockId), [
    'title:0',
    'summary:0',
    'summary:1',
    'outcomes:0',
    'outcomes:1',
    'details:0',
    'details:1',
  ]);
  assert.equal(blocks.find((block) => block.blockId === 'outcomes:0')?.label, 'Commitment 1');
});

test('suggestions reconstruct complete field replacements', () => {
  const applied = applySuggestions(base, [
    suggestion({ field: 'title', index: 0, original: base.title, proposed: 'Frequent regional trains' }),
    suggestion({ field: 'summary', index: 1, original: 'Connections are poor.', proposed: 'Connections need to be reliable.' }),
    suggestion({ field: 'outcomes', index: 2, original: '', proposed: 'Publish a delivery timetable', mode: 'add' }),
    suggestion({ field: 'details', index: 0, original: 'The current timetable does not meet demand.', proposed: '', mode: 'remove' }),
  ]);
  assert.deepEqual(applied.unresolved, []);
  assert.equal(applied.changes.title, 'Frequent regional trains');
  assert.equal(applied.changes.summary, 'Trains are infrequent.\n\nConnections need to be reliable.');
  assert.deepEqual(applied.changes.outcomes, ['Run more services', 'Improve connections', 'Publish a delivery timetable']);
  assert.equal(applied.changes.details, 'Rural towns are isolated.');
});

test('strict application refuses a suggestion whose quoted block changed', () => {
  const applied = applySuggestions(base, [
    suggestion({ index: 0, original: 'Different wording', proposed: 'Replacement' }),
  ]);
  assert.deepEqual(applied.unresolved, ['summary']);
  assert.deepEqual(applied.changes, {});
});

test('classification distinguishes clean, moved and conflicting anchors', () => {
  const latest = wordingSnapshot({
    ...base,
    details: 'A new opening paragraph.\n\nThe current timetable does not meet demand.\n\nRural towns are isolated.',
    outcomes: ['Run more services'],
  });
  const classifications = classifySuggestions(base, latest, [
    suggestion({ suggestionId: 'clean', index: 0, original: 'Trains are infrequent.' }),
    suggestion({ suggestionId: 'moved', field: 'details', index: 1, original: 'Rural towns are isolated.' }),
    suggestion({ suggestionId: 'conflict', field: 'outcomes', index: 1, original: 'Improve connections' }),
  ]);
  assert.equal(classifications.find((row) => row.suggestionId === 'clean')?.state, 'clean');
  assert.equal(classifications.find((row) => row.suggestionId === 'moved')?.state, 'moved');
  assert.equal(classifications.find((row) => row.suggestionId === 'moved')?.index, 2);
  assert.equal(classifications.find((row) => row.suggestionId === 'conflict')?.state, 'conflict');
});

test('rebase moves anchors to the latest revision and rebuilds changes', () => {
  const latest = wordingSnapshot({
    ...base,
    summary: 'A new opening paragraph.\n\nTrains are infrequent.\n\nConnections are still poor.',
  });
  const rebased = rebaseSuggestions(
    [suggestion({ index: 0, original: 'Trains are infrequent.', proposed: 'Trains run hourly.' })],
    latest,
  );
  assert.deepEqual(rebased.unresolved, []);
  assert.equal(rebased.suggestions[0]?.index, 1);
  assert.equal(
    rebased.changes.summary,
    'A new opening paragraph.\n\nTrains run hourly.\n\nConnections are still poor.',
  );
});

test('rebase reports an anchor that no longer exists', () => {
  const latest = wordingSnapshot({ ...base, summary: 'Completely rewritten.' });
  const rebased = rebaseSuggestions(
    [suggestion({ index: 0, original: 'Trains are infrequent.', proposed: 'Trains run hourly.' })],
    latest,
  );
  assert.deepEqual(rebased.unresolved, ['summary']);
});

test('competing amendments are found by block, not by field', () => {
  const a = [suggestion({ field: 'outcomes', index: 1, original: 'Improve connections', proposed: 'Better connections' })];
  const b = [suggestion({ field: 'outcomes', index: 1, original: 'Improve connections', proposed: 'Reliable connections' })];
  const c = [suggestion({ field: 'outcomes', index: 0, original: 'Run more services', proposed: 'Run many more services' })];
  assert.deepEqual(competingTargets(a, b), ['outcomes:1']);
  assert.deepEqual(competingTargets(a, c), []);
});

test('suggestion input is bounded and only one suggestion may target a block', () => {
  assert.throws(() => normalizeSuggestions([]), /at least one/);
  assert.throws(
    () => normalizeSuggestions([
      { field: 'summary', index: 0, original: 'A', proposed: 'B' },
      { field: 'summary', index: 0, original: 'A', proposed: 'C' },
    ]),
    /same block/,
  );
  assert.throws(
    () => normalizeSuggestions([{ field: 'title', index: 0, original: 'A', proposed: '' }]),
    /title suggestion/,
  );
});

test('word diff keeps unchanged words and marks edits', () => {
  const segments = diffWords('Trains are infrequent.', 'Trains run hourly.');
  const same = segments.filter((segment) => segment.type === 'same').map((segment) => segment.text).join('');
  assert.ok(same.startsWith('Trains'));
  assert.ok(segments.some((segment) => segment.type === 'remove' && segment.text.includes('infrequent')));
  assert.ok(segments.some((segment) => segment.type === 'add' && segment.text.includes('hourly')));
});

test('multiple additions in one field are applied in the order written', () => {
  const applied = applySuggestions(base, [
    suggestion({ field: 'outcomes', index: 2, original: '', proposed: 'Third commitment', mode: 'add' }),
    suggestion({ field: 'outcomes', index: 2, original: '', proposed: 'Fourth commitment', mode: 'add' }),
    suggestion({ field: 'details', index: 2, original: '', proposed: 'Third rationale paragraph.', mode: 'add' }),
    suggestion({ field: 'details', index: 2, original: '', proposed: 'Fourth rationale paragraph.', mode: 'add' }),
  ]);
  assert.deepEqual(applied.unresolved, []);
  assert.deepEqual(applied.changes.outcomes, [
    'Run more services',
    'Improve connections',
    'Third commitment',
    'Fourth commitment',
  ]);
  assert.equal(
    applied.changes.details,
    'The current timetable does not meet demand.\n\nRural towns are isolated.\n\nThird rationale paragraph.\n\nFourth rationale paragraph.',
  );
});

test('additions, removals and replacements in one field do not shift each other', () => {
  const applied = applySuggestions(base, [
    suggestion({ field: 'outcomes', index: 0, original: 'Run more services', proposed: 'Run many more services' }),
    suggestion({ field: 'outcomes', index: 1, original: 'Improve connections', proposed: '', mode: 'remove' }),
    suggestion({ field: 'outcomes', index: 2, original: '', proposed: 'Add a new connection', mode: 'add' }),
  ]);
  assert.deepEqual(applied.unresolved, []);
  assert.deepEqual(applied.changes.outcomes, ['Run many more services', 'Add a new connection']);
});

test('repeated wording is ambiguous and is not rebased by guessing', () => {
  const repeated = wordingSnapshot({
    ...base,
    outcomes: ['Same commitment', 'Same commitment', 'Something else'],
  });
  const rebased = rebaseSuggestions(
    [suggestion({ field: 'outcomes', index: 0, original: 'Same commitment', proposed: 'Changed' })],
    { ...repeated, outcomes: ['A new first commitment', 'Same commitment', 'Same commitment', 'Something else'] },
  );
  assert.deepEqual(rebased.unresolved, ['outcomes']);
  const classifications = classifySuggestions(
    repeated,
    { ...repeated, outcomes: ['A new first commitment', 'Same commitment', 'Same commitment', 'Something else'] },
    [suggestion({ field: 'outcomes', index: 0, original: 'Same commitment', proposed: 'Changed' })],
  );
  assert.equal(classifications[0]?.state, 'conflict');
});

test('several additions at the same insertion point are retained in order', () => {
  const applied = applySuggestions(base, [
    suggestion({ field: 'outcomes', index: 0, original: '', proposed: 'First new', mode: 'add' }),
    suggestion({ field: 'outcomes', index: 0, original: '', proposed: 'Second new', mode: 'add' }),
  ]);
  assert.deepEqual(applied.changes.outcomes, ['First new', 'Second new', 'Run more services', 'Improve connections']);
});

test('wording validation happens on the resulting whole field', () => {
  assert.deepEqual(validateWordingChanges({ title: 'Valid title' }), []);
  assert.match(validateWordingChanges({ title: 'x'.repeat(201) })[0] ?? '', /4–200/);
  assert.match(validateWordingChanges({ summary: 'Too short' })[0] ?? '', /10–2,000/);
  assert.match(validateWordingChanges({ outcomes: ['x'.repeat(501)] })[0] ?? '', /under 500/);
});

test('competition detection falls back to fields for legacy amendments', () => {
  assert.equal(
    amendmentsCompete(
      { fields: ['title'] },
      { fields: ['title', 'summary'] },
    ),
    true,
  );
  assert.equal(
    amendmentsCompete(
      { fields: ['title'] },
      { fields: ['summary'] },
    ),
    false,
  );
});

test('rebase moves an insertion when an earlier block is added', () => {
  const anchored = anchorSuggestions(base, [
    suggestion({ field: 'outcomes', index: 1, original: '', proposed: 'Inserted commitment', mode: 'add' }),
  ]);
  const latest = wordingSnapshot({
    ...base,
    outcomes: ['A new leading commitment', 'Run more services', 'Improve connections'],
  });
  const rebased = rebaseSuggestions(anchored, latest);
  assert.deepEqual(rebased.unresolved, []);
  assert.equal(rebased.suggestions[0]?.index, 2);
  assert.deepEqual(rebased.changes.outcomes, [
    'A new leading commitment',
    'Run more services',
    'Inserted commitment',
    'Improve connections',
  ]);
});

test('rebase refuses an insertion whose surrounding anchors are ambiguous', () => {
  const repeated = wordingSnapshot({ ...base, outcomes: ['A', 'A', 'B'] });
  const anchored = anchorSuggestions(repeated, [
    suggestion({ field: 'outcomes', index: 1, original: '', proposed: 'Between', mode: 'add' }),
  ]);
  const rebased = rebaseSuggestions(anchored, { ...repeated, outcomes: ['X', 'A', 'A', 'B'] });
  assert.deepEqual(rebased.unresolved, ['outcomes']);
});

test('paragraph splitting ignores empty prose', () => {
  assert.deepEqual(paragraphs('  \n\n '), []);
  assert.deepEqual(paragraphs('One\r\n\r\nTwo'), ['One', 'Two']);
});

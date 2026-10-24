import test from 'node:test';
import assert from 'node:assert/strict';
import catalogue from '../../data/policy-catalogue.json' with { type: 'json' };
import { policyTaxonomy, validateTaxonomy, taxonomyMigrationPatch } from './taxonomy.ts';

test('Reclaim hierarchy is editorial; conservative subjects preserve uncertainty', () => {
  assert.equal(catalogue.length, 76);
  for (const entry of catalogue) {
    const taxonomy = policyTaxonomy(entry);
    assert.equal(taxonomy.programme, 'Reclaim');
    assert.equal(taxonomy.pillar, entry.division);
    assert.equal(taxonomy.editorialHeading, entry.domain);
    assert.notEqual(taxonomy.domain, entry.division);
    assert.notEqual(taxonomy.domain, entry.domain);
    const migrated = { ...entry, ...taxonomyMigrationPatch(entry) };
    assert.deepEqual(taxonomyMigrationPatch(migrated), {});
    for (const key of ['policyId', 'version', 'url', 'anchor', 'statement', 'details', 'provenance', 'initialAgmRound'] as const) {
      assert.deepEqual(migrated[key], entry[key]);
    }
  }
  assert.equal(policyTaxonomy(catalogue[9]!).domain, 'Housing');
  assert.equal(policyTaxonomy(catalogue[18]!).domain, null); // rail inside the housing editorial heading
  assert.equal(policyTaxonomy(catalogue[0]!).domain, null); // mixed editorial grouping
});

test('future programmes and standalone policies retain explicit taxonomy', () => {
  const standalone = validateTaxonomy({ domain: 'Transport' });
  assert.deepEqual(standalone, { value: { taxonomyVersion: 1, programme: null, pillar: null, editorialHeading: null, domain: 'Transport' } });
  const future = validateTaxonomy({ programme: 'Future review', pillar: 'Regional priorities', editorialHeading: 'Connections', domain: 'Transport' });
  assert.ok('value' in future);
  assert.deepEqual(validateTaxonomy({ domain: null }, future.value), { value: { ...future.value, domain: null } });
  assert.deepEqual(validateTaxonomy({}, future.value), future);
  assert.ok('error' in validateTaxonomy({ pillar: 'Orphan pillar' }));
  assert.ok('error' in validateTaxonomy({ domain: 'RECLAIM OUR ECONOMY' }));
  assert.equal(policyTaxonomy({ policyId: 'FUTURE-1', domain: 'Transport' }).programme, null);
  assert.deepEqual(taxonomyMigrationPatch({ ...catalogue[0], taxonomyVersion: 1, domain: 'Social security' }), {});
});

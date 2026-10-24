import catalogue from '../../data/policy-catalogue.json' with { type: 'json' };

export interface PolicyTaxonomy {
  taxonomyVersion: 1;
  programme: string | null;
  pillar: string | null;
  editorialHeading: string | null;
  domain: string | null;
}
type LegacyTaxonomy = Partial<Omit<PolicyTaxonomy, 'taxonomyVersion'>> & { taxonomyVersion?: number; policyId?: string; division?: string };

// An explicit migration crosswalk, not automatic classification or a national taxonomy.
const subjectGroups: [string, number[]][] = [
  ['Housing', [10, 11, 12, 13, 14, 15, 16, 17, 18]],
  ['Taxation', [21, 22]],
  ['Small business', [25, 26, 27, 30, 31, 32]],
  ['Energy', [33, 34, 35]],
  ['Democracy and governance', [39, 40, 41, 42, 43]],
  ['Media', [44, 45, 46]],
  ['School education', [57, 58, 59, 60]],
  ['Environment', [71, 72, 73, 74, 75, 76]],
];
const subjects = new Map<string, string>(subjectGroups.flatMap(([subject, ids]) => ids.map(id => [`POL-${String(id).padStart(3, '0')}`, subject] as const)));
const headings = new Set(catalogue.map(entry => entry.domain));
const pillars = new Set(catalogue.map(entry => entry.division));
const editorialLabels = new Set([...pillars, ...headings].map(label => label.toLowerCase()));

/** Read old records without modifying their wording, IDs or public route metadata. */
export function policyTaxonomy(record: LegacyTaxonomy): PolicyTaxonomy {
  if (record.taxonomyVersion === 1) return {
    taxonomyVersion: 1, programme: record.programme ?? null, pillar: record.pillar ?? null,
    editorialHeading: record.editorialHeading ?? null, domain: record.domain ?? null,
  };
  const baseline = catalogue.find(entry => entry.policyId === record.policyId);
  const legacyHeading = record.domain && headings.has(record.domain) ? record.domain : null;
  const legacyPillar = record.division && pillars.has(record.division) ? record.division : baseline?.division;
  return {
    taxonomyVersion: 1,
    programme: record.programme ?? (legacyPillar ? 'Reclaim' : null),
    pillar: record.pillar ?? legacyPillar ?? null,
    editorialHeading: record.editorialHeading ?? legacyHeading,
    domain: legacyHeading || !record.domain ? subjects.get(record.policyId ?? '') ?? null : record.domain,
  };
}

export function taxonomyMigrationPatch(record: LegacyTaxonomy): Partial<PolicyTaxonomy> {
  return record.taxonomyVersion === 1 ? {} : policyTaxonomy(record);
}

/** Optional strings keep this a small editorial model; null explicitly clears a classification. */
export function validateTaxonomy(input: Record<string, unknown>, previous?: LegacyTaxonomy): { value: PolicyTaxonomy } | { error: string } {
  const value = previous ? policyTaxonomy(previous) : policyTaxonomy({});
  for (const key of ['programme', 'pillar', 'editorialHeading', 'domain'] as const) {
    if (input[key] === undefined) continue;
    const field = input[key];
    if (field !== null && (typeof field !== 'string' || field.trim().length > 120)) return { error: `${key} must be text of at most 120 characters, or null.` };
    value[key] = typeof field === 'string' ? field.trim() || null : null;
  }
  if (!value.programme && (value.pillar || value.editorialHeading)) return { error: 'Choose a programme for an editorial pillar or heading.' };
  const knownPillar = [...pillars].find(label => label.toLowerCase() === value.pillar?.toLowerCase());
  const knownHeading = [...headings].find(label => label.toLowerCase() === value.editorialHeading?.toLowerCase());
  if ((knownPillar || knownHeading) && value.programme !== 'Reclaim') return { error: 'Reclaim editorial pillars and headings require the Reclaim programme.' };
  if (value.programme === 'Reclaim') {
    if (value.pillar && !pillars.has(value.pillar)) return { error: 'Choose a known Reclaim editorial pillar.' };
    if (value.editorialHeading && !headings.has(value.editorialHeading)) return { error: 'Choose a known Reclaim editorial heading.' };
    if (value.pillar && value.editorialHeading && !catalogue.some(entry => entry.division === value.pillar && entry.domain === value.editorialHeading)) return { error: 'The editorial heading does not belong to that Reclaim pillar.' };
  }
  if (value.domain && editorialLabels.has(value.domain.toLowerCase())) return { error: 'Use a subject domain rather than a Reclaim editorial pillar or heading.' };
  return { value };
}

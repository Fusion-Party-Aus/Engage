import * as React from 'react';
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface ProposalScopeSelectorOption {
  key: string;
  label: string;
  kind?: string;
  branchName?: string;
  parentName?: string;
}

interface ProposalScopeSelectorProps {
  options: ProposalScopeSelectorOption[];
  defaultValue: string;
  hint?: string;
}

/**
 * Proposal destination selection.
 *
 * Nine geographic destinations plus a potentially long list of local branches
 * do not fit a radio group. A single grouped select keeps the control compact,
 * exposes the full list on demand, supports type-ahead and keyboard navigation,
 * and remains usable on mobile.
 *
 * The hidden input carries the canonical scope key (or an exact branch
 * identifier for a local branch). A display label is never submitted.
 */
export default function ProposalScopeSelector({
  options,
  defaultValue,
  hint,
}: ProposalScopeSelectorProps) {
  const fallback = options[0]?.key ?? 'national';
  const [scope, setScope] = React.useState(() =>
    options.some((option) => option.key === defaultValue) ? defaultValue : fallback,
  );

  const geographic = options.filter((option) => option.kind !== 'constituent');
  const local = options.filter((option) => option.kind === 'constituent');
  const selected = options.find((option) => option.key === scope);
  const selectedLabel = selected
    ? selected.parentName
      ? `${selected.label} · ${selected.parentName}`
      : selected.label
    : undefined;

  return (
    <FieldSet className="gap-2" data-proposal-scope-selector>
      <FieldLegend className="mb-0">Proposal scope</FieldLegend>
      <input type="hidden" name="scope" value={scope} />

      <Select value={scope} onValueChange={setScope}>
        <SelectTrigger
          aria-label="Proposal scope"
          aria-describedby="proposal-scope-hint"
        >
          <SelectValue placeholder="Choose a proposal scope">{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>National and states/territories</SelectLabel>
            {geographic.map((option) => (
              <SelectItem
                key={option.key}
                value={option.key}
                textValue={option.label}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {local.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Local branches</SelectLabel>
                {local.map((option) => (
                  <SelectItem
                    key={option.key}
                    value={option.key}
                    textValue={
                      option.parentName
                        ? `${option.label} ${option.parentName}`
                        : option.label
                    }
                  >
                    <span className="flex w-full items-baseline justify-between gap-3">
                      <span>{option.label}</span>
                      {option.parentName && (
                        <span className="text-xs text-muted-foreground">
                          {option.parentName}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>

      <FieldDescription id="proposal-scope-hint">
        {hint ??
          'National proposals are open to every member. You can also submit to any state, territory, or local branch. Submitting does not grant voting rights in that branch.'}
      </FieldDescription>
      {selected?.branchName && selected.branchName !== selected.label ? (
        <FieldDescription className="text-xs">
          {selected.branchName} branch
        </FieldDescription>
      ) : null}
    </FieldSet>
  );
}

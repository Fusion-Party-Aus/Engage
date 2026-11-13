import * as React from 'react';
import { Check } from 'lucide-react';
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface ProposalScopeSelectorOption {
  key: string;
  label: string;
  branchName?: string;
}

interface ProposalScopeSelectorProps {
  options: ProposalScopeSelectorOption[];
  defaultValue: string;
  hint?: string;
}

/**
 * Geographic proposal scope selection. The hidden input carries the canonical
 * scope key; the visible label is never submitted as an identifier.
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
  const selected = options.find((option) => option.key === scope);

  return (
    <FieldSet className="gap-2" data-proposal-scope-selector>
      <FieldLegend className="mb-0">Proposal scope</FieldLegend>
      <input type="hidden" name="scope" value={scope} />
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={1}
        value={scope}
        onValueChange={(next) => {
          if (next) setScope(next);
        }}
        aria-label="Proposal scope"
        aria-describedby="proposal-scope-hint"
        className="flex w-full flex-wrap items-stretch"
      >
        {options.map((option) => {
          const isSelected = option.key === scope;
          return (
            <ToggleGroupItem
              key={option.key}
              value={option.key}
              aria-label={
                option.branchName && option.branchName !== option.label
                  ? `${option.label} — ${option.branchName} branch`
                  : option.label
              }
              className="h-auto min-h-11 flex-1 basis-[calc(50%-0.25rem)] whitespace-normal px-3 py-2 text-sm data-[state=on]:border-secondary data-[state=on]:bg-secondary data-[state=on]:font-semibold data-[state=on]:text-secondary-foreground sm:basis-[calc(33.333%-0.25rem)]"
            >
              <span className="flex items-center justify-center gap-1.5">
                <Check
                  aria-hidden="true"
                  className={isSelected ? 'size-4' : 'hidden'}
                />
                {option.label}
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <FieldDescription id="proposal-scope-hint">
        {hint ??
          'National proposals are open to every member. Branch proposals stay within the branch you administer.'}
      </FieldDescription>
      {selected?.branchName && selected.branchName !== selected.label ? (
        <FieldDescription className="text-xs">
          {selected.branchName} branch
        </FieldDescription>
      ) : null}
    </FieldSet>
  );
}

import * as React from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  parentName?: string;
}

interface ProposalScopeSelectorProps {
  geographicOptions: ProposalScopeSelectorOption[];
  localOptions?: ProposalScopeSelectorOption[];
  defaultValue: string;
  hint?: string;
}

const itemClassName =
  'h-auto min-h-11 flex-1 basis-[calc(50%-0.25rem)] whitespace-normal px-3 py-2 text-sm data-[state=on]:border-secondary data-[state=on]:bg-secondary data-[state=on]:font-semibold data-[state=on]:text-secondary-foreground sm:basis-[calc(33.333%-0.25rem)]';

/**
 * Proposal destination selection. Geographic scope (National plus states and
 * territories) is always visible; constituent/local branches sit behind a
 * disclosure so they remain discoverable without overwhelming the form.
 *
 * The hidden input carries the canonical scope key (or an exact branch
 * identifier for a local branch). A display label is never submitted.
 */
export default function ProposalScopeSelector({
  geographicOptions,
  localOptions = [],
  defaultValue,
  hint,
}: ProposalScopeSelectorProps) {
  const allOptions = [...geographicOptions, ...localOptions];
  const fallback = geographicOptions[0]?.key ?? 'national';
  const [scope, setScope] = React.useState(() =>
    allOptions.some((option) => option.key === defaultValue)
      ? defaultValue
      : fallback,
  );
  const initialGeographic = geographicOptions.some(
    (option) => option.key === defaultValue,
  )
    ? defaultValue
    : fallback;
  const [lastGeographic, setLastGeographic] =
    React.useState(initialGeographic);

  const localSelected = localOptions.some((option) => option.key === scope);
  const selected = allOptions.find((option) => option.key === scope);
  const selectedLocal = localOptions.find((option) => option.key === scope);

  const chooseGeographic = (next: string) => {
    setLastGeographic(next);
    setScope(next);
  };

  const chooseLocal = (next: string) => {
    if (next) setScope(next);
  };

  const localSummary = selectedLocal
    ? `Local branch: ${selectedLocal.label}`
    : localOptions.length
      ? 'Local branch (optional)'
      : '';

  return (
    <FieldSet className="gap-2" data-proposal-scope-selector>
      <FieldLegend className="mb-0">Proposal scope</FieldLegend>
      <input type="hidden" name="scope" value={scope} />

      <ToggleGroup
        type="single"
        variant="outline"
        spacing={1}
        value={localSelected ? '' : scope}
        onValueChange={(next) => {
          if (next) chooseGeographic(next);
        }}
        aria-label="Proposal scope"
        aria-describedby="proposal-scope-hint"
        className="flex w-full flex-wrap items-stretch"
      >
        {geographicOptions.map((option) => {
          const isSelected = !localSelected && option.key === scope;
          return (
            <ToggleGroupItem
              key={option.key}
              value={option.key}
              aria-label={
                option.branchName && option.branchName !== option.label
                  ? `${option.label} — ${option.branchName} branch`
                  : option.label
              }
              className={itemClassName}
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

      {localOptions.length > 0 && (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            {localSummary}
          </summary>
          <div className="mt-2 grid gap-2">
            {localSelected && (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => chooseGeographic(lastGeographic)}
                >
                  Clear local branch
                </Button>
              </div>
            )}
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={localSelected ? scope : ''}
              onValueChange={chooseLocal}
              aria-label="Local branch"
              aria-describedby="proposal-scope-hint"
              className="flex w-full flex-wrap items-stretch"
            >
              {localOptions.map((option) => {
                const isSelected = option.key === scope;
                return (
                  <ToggleGroupItem
                    key={option.key}
                    value={option.key}
                    aria-label={
                      option.parentName
                        ? `${option.label}, local branch of ${option.parentName}`
                        : option.label
                    }
                    className={itemClassName}
                  >
                    <span className="grid items-center justify-items-center gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <Check
                          aria-hidden="true"
                          className={isSelected ? 'size-4' : 'hidden'}
                        />
                        {option.label}
                      </span>
                      {option.parentName && (
                        <span className="text-xs font-normal opacity-80">
                          {option.parentName}
                        </span>
                      )}
                    </span>
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </details>
      )}

      <FieldDescription id="proposal-scope-hint">
        {hint ??
          'National proposals are open to every member. Any member may also submit to a state, territory, or local branch; this does not grant voting rights in that branch.'}
      </FieldDescription>
      {selectedLocal ? (
        <FieldDescription className="text-xs">
          {selectedLocal.branchName ?? selectedLocal.label}
          {selectedLocal.parentName ? ` · part of ${selectedLocal.parentName}` : ''}
        </FieldDescription>
      ) : selected?.branchName && selected.branchName !== selected.label ? (
        <FieldDescription className="text-xs">
          {selected.branchName} branch
        </FieldDescription>
      ) : null}
    </FieldSet>
  );
}

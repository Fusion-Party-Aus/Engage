import * as React from 'react';
import { Check } from 'lucide-react';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface PolicyChangeTypeOption {
  value: string;
  label: string;
  description: string;
}

interface PolicyChangeTypeSelectorProps {
  options: PolicyChangeTypeOption[];
  defaultValue: string;
  describedBy?: string;
}

/**
 * How a proposal changes an already adopted policy.
 *
 * The action is a single choice presented as three readable options, not a
 * dropdown. The hidden input carries the canonical change type; the page listens
 * for `policy-change-type` so the rest of the form can follow the choice. The
 * selected label is never submitted, so display wording can change without
 * altering behaviour.
 */
export default function PolicyChangeTypeSelector({
  options,
  defaultValue,
  describedBy,
}: PolicyChangeTypeSelectorProps) {
  const fallback = options[0]?.value ?? 'amend';
  const [value, setValue] = React.useState(() =>
    options.some((option) => option.value === defaultValue)
      ? defaultValue
      : fallback,
  );

  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('policy-change-type', { detail: value }),
    );
  }, [value]);

  return (
    <FieldSet className="gap-2" data-policy-change-selector>
      <FieldLegend className="mb-0">What would you like to do?</FieldLegend>
      <input type="hidden" name="changeType" value={value} />
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          // A required choice cannot be cleared by clicking it again.
          if (next) setValue(next);
        }}
        aria-label="What would you like to do?"
        aria-describedby={describedBy}
        className="grid w-full"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="mb-2 h-auto w-full items-start justify-start gap-3 rounded-lg border border-[var(--horizon-line)] bg-[var(--horizon-surface)] px-4 py-3 text-left whitespace-normal last:mb-0 data-[state=on]:border-2 data-[state=on]:border-[var(--horizon-purple)] data-[state=on]:bg-[var(--horizon-lavender-soft)] data-[state=on]:hover:bg-[var(--horizon-lavender-soft)] data-[state=on]:[&_.action-check]:opacity-100"
          >
            <span
              aria-hidden="true"
              className="action-check mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--horizon-line-strong)] text-[var(--horizon-purple)] opacity-0"
            >
              <Check className="size-3" />
            </span>
            <span className="grid gap-0.5">
              <span className="font-semibold text-[var(--horizon-ink)]">
                {option.label}
              </span>
              <span className="text-sm font-normal text-[var(--horizon-muted)]">
                {option.description}
              </span>
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </FieldSet>
  );
}

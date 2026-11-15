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
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface PolicyChangeTypeOption {
  value: string;
  label: string;
}

interface PolicyChangeTypeSelectorProps {
  options: PolicyChangeTypeOption[];
  defaultValue: string;
  hint?: string;
}

/**
 * How a proposal changes an already adopted policy.
 *
 * The hidden input carries the canonical change type. The selected label is
 * never submitted, so display wording can change without altering behaviour.
 */
export default function PolicyChangeTypeSelector({
  options,
  defaultValue,
  hint,
}: PolicyChangeTypeSelectorProps) {
  const fallback = options[0]?.value ?? 'amend';
  const [value, setValue] = React.useState(() =>
    options.some((option) => option.value === defaultValue)
      ? defaultValue
      : fallback,
  );
  const selected = options.find((option) => option.value === value);

  return (
    <FieldSet className="gap-2" data-policy-change-selector>
      <FieldLegend className="mb-0">What should happen to this policy?</FieldLegend>
      <input type="hidden" name="changeType" value={value} />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger
          aria-label="What should happen to this policy?"
          aria-describedby="policy-change-hint"
        >
          <SelectValue placeholder="Choose a change">
            {selected?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                textValue={option.label}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription id="policy-change-hint">
        {hint ??
          'Submitting leaves the current policy unchanged. An adopted amendment or replacement takes effect when published; a repeal takes effect at ratification.'}
      </FieldDescription>
    </FieldSet>
  );
}

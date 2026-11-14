import * as React from 'react';
import { AlertCircle, Check, MessageCircle, PenLine } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const STANCES = [
  { value: 'comment', label: 'Comment', Icon: MessageCircle },
  { value: 'support', label: 'Support', Icon: Check },
  { value: 'concern', label: 'Concern', Icon: AlertCircle },
  { value: 'amendment', label: 'Wording', Icon: PenLine },
];

export default function StanceSelector({ defaultValue = 'comment' }: { defaultValue?: string }) {
  const [stance, setStance] = React.useState(defaultValue);

  React.useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[data-stance-input]');
    const pending = input?.dataset.pendingStance;
    if (pending) {
      setStance(pending);
      delete input.dataset.pendingStance;
    }
    const selectStance = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (next) setStance(next);
    };
    window.addEventListener('engage:stance', selectStance);
    return () => window.removeEventListener('engage:stance', selectStance);
  }, []);

  return (
    <>
      <input type="hidden" name="stance" value={stance} data-stance-input />
      <ToggleGroup
        type="single"
        value={stance}
        onValueChange={(next) => next && setStance(next)}
        className="stance-radio-group"
        aria-label="Contribution stance"
      >
        {STANCES.map(({ value, label, Icon }) => (
          <ToggleGroupItem key={value} value={value} className="stance-choice">
            <Icon aria-hidden="true" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  );
}

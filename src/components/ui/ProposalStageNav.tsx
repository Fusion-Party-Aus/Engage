import { Compass, Lightbulb, MessageCircle, Vote, Flag } from 'lucide-react';
import { Button } from './button';
import { Badge } from './badge';
import { cn } from '@/lib/utils';

type Stage = 'all' | 'propose' | 'deliberate' | 'decide' | 'implement';
interface Props {
  active: Stage;
  space: string;
  counts: Record<Stage, number>;
}

const options: Array<[Stage, string]> = [
  ['all', 'Everything'],
  ['propose', 'New ideas'],
  ['deliberate', 'In discussion'],
  ['decide', 'Open votes'],
  ['implement', 'Implement'],
];

const cues = {
  all: { icon: Compass, colour: 'text-[var(--horizon-purple)]' },
  propose: { icon: Lightbulb, colour: 'text-[var(--horizon-violet)]' },
  deliberate: { icon: MessageCircle, colour: 'text-[var(--horizon-magenta)]' },
  decide: { icon: Vote, colour: 'text-[var(--horizon-voting-ink)]' },
  implement: { icon: Flag, colour: 'text-[var(--horizon-focus)]' },
};

const hrefFor = (stage: Stage, space: string) => {
  const params = new URLSearchParams();
  if (stage !== 'all') params.set('stage', stage);
  if (space !== 'all') params.set('space', space);
  return `/proposals/${params.size ? `?${params}` : ''}`;
};

export default function ProposalStageNav({ active, space, counts }: Props) {
  return (
    <nav className="flex flex-wrap items-center gap-2 border-b border-border pb-4" aria-label="Filter proposals by stage">
      {options.map(([stage, label]) => {
        const { icon: Icon, colour } = cues[stage];
        return <Button
          key={stage}
          variant={active === stage ? 'secondary' : 'ghost'}
          size="sm"
          className={cn('min-h-11 gap-2 rounded-full', active === stage && 'ring-1 ring-[var(--horizon-purple)]')}
          href={hrefFor(stage, space)}
          aria-current={active === stage ? 'page' : undefined}
        >
          <Icon className={cn('size-4', colour)} aria-hidden="true" />
          {label}
          <Badge variant="outline" className="bg-background text-xs tabular-nums">{counts[stage]}</Badge>
        </Button>;
      })}
    </nav>
  );
}

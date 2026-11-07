import { buttonVariants } from './button';
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

const hrefFor = (stage: Stage, space: string) => {
  const params = new URLSearchParams();
  if (stage !== 'all') params.set('stage', stage);
  if (space !== 'all') params.set('space', space);
  return `/proposals/${params.size ? `?${params}` : ''}`;
};

export default function ProposalStageNav({ active, space, counts }: Props) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2" aria-label="Filter proposals by stage">
      {options.map(([stage, label]) => (
        <a
          key={stage}
          className={cn(buttonVariants({ variant: active === stage ? 'secondary' : 'ghost', size: 'sm' }), 'gap-2')}
          href={hrefFor(stage, space)}
          aria-current={active === stage ? 'page' : undefined}
        >
          {label}
          <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[.7rem] font-bold tabular-nums">{counts[stage]}</span>
        </a>
      ))}
    </nav>
  );
}

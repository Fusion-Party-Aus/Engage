import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap transition-[color,box-shadow] [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border bg-background text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        success: 'border-transparent bg-[var(--horizon-success-bg)] text-[var(--horizon-success-ink)]',
        warning: 'border-transparent bg-[var(--horizon-warn-bg)] text-[var(--horizon-warn-ink)]',
        info: 'border-transparent bg-[var(--horizon-voting-bg)] text-[var(--horizon-voting-ink)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({ className, variant, asChild = false, label, children, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean; label?: React.ReactNode }) {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>{label ?? children}</Comp>;
}

export { Badge, badgeVariants };

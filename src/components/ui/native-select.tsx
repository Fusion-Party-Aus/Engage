import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

function NativeSelect({
  className,
  wrapperClassName,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default'; wrapperClassName?: string }) {
  return (
    <div
      data-slot="native-select-wrapper"
      className={cn('group/native-select relative has-[select:disabled]:opacity-50', wrapperClassName ?? 'w-full')}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          'h-10 w-full min-w-0 appearance-none rounded-md border border-input bg-background px-3 py-2 pr-9 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] md:text-sm',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
          size === 'sm' && 'h-8 text-xs',
          className,
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { NativeSelect };

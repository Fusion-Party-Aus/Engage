import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SettingsSection({
  title,
  description,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Card>, 'title'> & {
  title: string;
  description: string;
}) {
  return (
    <Card className={cn('gap-0 pb-0 shadow-none', className)} {...props}>
      <CardHeader className="gap-1 border-b px-5 py-4">
        <CardTitle
          aria-level={2}
          className="font-heading text-xl leading-tight font-semibold"
          role="heading"
        >
          {title}
        </CardTitle>
        <CardDescription className="text-sm">{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  );
}

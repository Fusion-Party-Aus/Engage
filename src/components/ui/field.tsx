import * as React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

interface FieldProps extends React.ComponentProps<'div'> {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
}

function Field({ className, label, htmlFor, hint, error, children, ...props }: FieldProps) {
  return (
    <div data-slot="field" className={cn('grid min-w-0 gap-2', className)} {...props}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {hint && !error && <p data-slot="field-description" className="text-sm text-muted-foreground">{hint}</p>}
      {error && <p data-slot="field-error" role="alert" className="text-sm font-medium text-destructive">{error}</p>}
    </div>
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field-group" className={cn('grid w-full gap-5', className)} {...props} />;
}

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return <fieldset data-slot="field-set" className={cn('flex min-w-0 flex-col gap-4', className)} {...props} />;
}

function FieldLegend({ className, ...props }: React.ComponentProps<'legend'>) {
  return <legend data-slot="field-legend" className={cn('mb-2 text-base font-semibold', className)} {...props} />;
}

export { Field, FieldGroup, FieldSet, FieldLegend };

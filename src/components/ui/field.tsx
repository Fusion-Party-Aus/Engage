import * as React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

type FieldOrientation = 'vertical' | 'horizontal' | 'responsive';

const fieldOrientation: Record<FieldOrientation, string> = {
  vertical: 'flex-col [&>*]:w-full',
  horizontal: 'flex-row items-center [&>*]:w-auto',
  responsive: 'flex-col [&>*]:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:[&>*]:w-auto',
};

interface FieldProps extends React.ComponentProps<'div'> {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  orientation?: FieldOrientation;
}

function Field({
  className,
  label,
  htmlFor,
  hint,
  error,
  orientation = 'vertical',
  children,
  ...props
}: FieldProps) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn('group/field flex w-full min-w-0 gap-3', fieldOrientation[orientation], className)}
      {...props}
    >
      {label && (
        <Label htmlFor={htmlFor} data-slot="field-label">
          {label}
        </Label>
      )}
      {children}
      {hint && !error && (
        <p data-slot="field-description" className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p data-slot="field-error" role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('group/field-group @container/field-group flex w-full flex-col gap-5', className)}
      {...props}
    />
  );
}

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn('flex min-w-0 flex-col gap-4', className)}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-2 font-semibold',
        variant === 'legend' ? 'text-base' : 'text-sm',
        className,
      )}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('flex flex-1 flex-col gap-1 leading-snug', className)}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn('w-fit leading-snug', className)} {...props} />;
}

function FieldTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn('flex w-fit items-center gap-2 text-sm font-semibold leading-snug', className)}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-sm font-normal leading-normal text-muted-foreground', className)}
      {...props}
    />
  );
}

function FieldSeparator({ children, className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-separator"
      data-content={Boolean(children)}
      className={cn('relative -my-2 h-5 text-sm', className)}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          data-slot="field-separator-content"
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
        >
          {children}
        </span>
      )}
    </div>
  );
}

function FieldError({ className, children, errors, ...props }: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = children ?? (errors?.length
    ? errors.length === 1
      ? errors[0]?.message
      : errors.map((error, index) => (error?.message ? <li key={index}>{error.message}</li> : null))
    : null);
  if (!content) return null;
  return (
    <div role="alert" data-slot="field-error" className={cn('text-sm font-normal text-destructive', className)} {...props}>
      {Array.isArray(content) ? <ul className="ml-4 flex list-disc flex-col gap-1">{content}</ul> : content}
    </div>
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
};

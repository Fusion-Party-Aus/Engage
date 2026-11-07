import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';

export function SettingField({
  label,
  description,
  htmlFor,
  children,
  className,
  ...props
}: ComponentProps<typeof Field> & {
  label: string;
  description: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Field
      className={cn('px-(--card-spacing) @md/field-group:items-center', className)}
      orientation="responsive"
      {...props}
    >
      <FieldContent>
        <FieldLabel className="text-sm font-semibold" htmlFor={htmlFor}>
          {label}
        </FieldLabel>
        <FieldDescription className="text-xs">{description}</FieldDescription>
      </FieldContent>
      <FieldContent className="items-start @md/field-group:items-end">{children}</FieldContent>
    </Field>
  );
}

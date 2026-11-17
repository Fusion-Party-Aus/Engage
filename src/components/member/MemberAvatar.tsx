import { Avatar, AvatarFallback } from '@/components/ui/avatar';

/**
 * Avatar with an initials fallback.
 *
 * Astro renders each imported React component as its own root, which breaks
 * Radix's `AvatarFallback` context when the primitives are imported separately
 * in a `.astro` file. This wrapper keeps the context in one React tree and
 * reuses the shadcn primitive.
 */
export default function MemberAvatar({
  initials,
  className,
  fallbackClassName,
}: {
  initials: string;
  className?: string;
  fallbackClassName?: string;
}) {
  return (
    <Avatar className={className}>
      <AvatarFallback className={fallbackClassName}>{initials}</AvatarFallback>
    </Avatar>
  );
}

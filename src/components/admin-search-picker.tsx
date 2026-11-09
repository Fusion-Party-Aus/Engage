import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickerResult {
  id: string;
  label: string;
  detail?: string;
}

/**
 * Debounced search-as-you-type picker (ARIA 1.2 combobox with listbox).
 * No separate "Find" button: results arrive ~250ms after typing stops.
 */
export function SearchPicker({
  label,
  placeholder,
  type,
  value,
  onChange,
  emptyHint = 'Type at least 2 letters to search.',
  branchId,
}: {
  label: string;
  placeholder?: string;
  type: 'member' | 'proposal';
  value: PickerResult | null;
  onChange: (value: PickerResult | null) => void;
  emptyHint?: string;
  branchId?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const params = new URLSearchParams({ type, q: query.trim() });
      if (branchId) params.set('branchId', branchId);
      const res = await fetch(`/api/admin/branches/search?${params.toString()}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (mine !== seq.current) return;
        if (!res.ok) throw new Error(data.error || 'Search failed.');
        setResults(data.results ?? []);
        setFailed('');
        setActive(0);
      } catch (cause) {
        if (mine === seq.current) setFailed(cause instanceof Error ? cause.message : 'Search failed.');
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query, type, branchId]);

  const choose = (item: PickerResult) => {
    onChange(item);
    setOpen(false);
    setQuery('');
  };

  if (value)
    return (
      <div className="grid gap-1.5">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2">
          <span className="min-w-0 text-sm">
            <strong className="block truncate">{value.label}</strong>
            {value.detail && <span className="block truncate text-xs text-muted-foreground">{value.detail}</span>}
          </span>
          <button type="button" aria-label={`Clear ${label.toLowerCase()}`} className="rounded p-1 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none" onClick={() => onChange(null)}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    );

  const status = loading ? 'Searching…' : failed ? failed : query.trim().length < 2 ? emptyHint : results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matches. Try a different spelling.';
  return (
    <div className="relative grid gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          className="h-10 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && open && results[active]) {
              e.preventDefault();
              choose(results[active]!);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">{status}</p>
      {open && results.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label={label} className="absolute top-[4.1rem] z-30 max-h-64 w-full overflow-auto rounded-md border bg-background p-1 shadow-lg">
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn('cursor-pointer rounded px-2.5 py-2 text-sm', i === active && 'bg-[var(--horizon-lavender)]')}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(item);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <strong className="block truncate">{item.label}</strong>
              {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

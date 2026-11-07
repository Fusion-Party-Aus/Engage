import { useState } from 'react';
import { Button } from './button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './dialog';

export default function MembershipRevoke({ branchId, memberId }: { branchId: string; memberId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function revoke() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/branches/memberships', { method:'DELETE', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({branchId,memberId}) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not revoke membership.');
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not revoke membership.'); setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline">Revoke membership and branch access</Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>Revoke branch access?</DialogTitle><DialogDescription>This removes this member’s active assignment to the branch. It does not change their party membership.</DialogDescription></DialogHeader>
      {error && <p className="text-sm font-medium text-destructive" role="alert">{error}</p>}
      <DialogFooter><DialogClose asChild><Button variant="outline" disabled={busy}>Cancel</Button></DialogClose><Button variant="destructive" disabled={busy} onClick={revoke}>{busy ? 'Revoking…' : 'Revoke access'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

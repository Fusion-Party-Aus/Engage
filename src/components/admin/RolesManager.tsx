import { useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import type {
  EffectivePermissionsSnapshot,
  PermissionDefinition,
  PermissionKey,
  PermissionScope,
  RoleAssignmentRecord,
  RoleDefinitionRecord,
} from "../../lib/rbac.ts";

interface MemberOption {
  memberId: string;
  name: string;
  email: string;
  role: string;
  roles?: string[];
  status: string;
}

interface BranchOption {
  branchId: string;
  name: string;
  kind: string;
}

interface AuditEntry {
  eventId?: string;
  action: string;
  actorName?: string;
  roleId: string;
  targetMemberId?: string;
  branchId?: string | null;
  createdAt: string;
}

interface Props {
  catalogue: PermissionDefinition[];
  initialRoles: RoleDefinitionRecord[];
  initialAssignments: RoleAssignmentRecord[];
  initialAuditLog: AuditEntry[];
  members: MemberOption[];
  branches: BranchOption[];
  currentMemberId: string;
}

export default function RolesManager({
  catalogue,
  initialRoles,
  initialAssignments,
  initialAuditLog,
  members,
  branches,
  currentMemberId,
}: Props) {
  const [roles, setRoles] = useState<RoleDefinitionRecord[]>(initialRoles);
  const [assignments, setAssignments] =
    useState<RoleAssignmentRecord[]>(initialAssignments);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>(initialAuditLog);

  // Role editor state
  const [editingRoleId, setEditingRoleId] = useState<string>("");
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [roleScope, setRoleScope] = useState<PermissionScope>("branch");
  const [selectedPerms, setSelectedPerms] = useState<Set<PermissionKey>>(
    new Set(),
  );
  const [roleStatus, setRoleStatus] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  // Assignment state
  const [assignMemberId, setAssignMemberId] = useState("");
  const [assignRoleId, setAssignRoleId] = useState("");
  const [assignBranchId, setAssignBranchId] = useState("");
  const [assignStatus, setAssignStatus] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);

  // Effective permissions inspector
  const [inspectMemberId, setInspectMemberId] = useState(currentMemberId);
  const [effectivePerms, setEffectivePerms] =
    useState<EffectivePermissionsSnapshot | null>(null);
  const [loadingInspect, setLoadingInspect] = useState(false);

  const memberName = (id?: string) => {
    if (!id) return "—";
    const found = members.find((m) => m.memberId === id);
    return found ? `${found.name} (${found.email})` : id;
  };
  const branchName = (id?: string | null) => {
    if (!id) return "National";
    return branches.find((b) => b.branchId === id)?.name ?? id;
  };
  const roleNameById = (id: string) =>
    roles.find((r) => r.roleId === id)?.name ?? id;

  const groupedCatalogue = useMemo(() => {
    const groups = new Map<string, PermissionDefinition[]>();
    for (const item of catalogue) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return [...groups.entries()];
  }, [catalogue]);

  const assignableRoles = useMemo(
    () => roles.filter((r) => !r.isSystem),
    [roles],
  );
  const selectedAssignRole = roles.find((r) => r.roleId === assignRoleId);

  async function refreshAll(memberToInspect?: string) {
    const q = memberToInspect
      ? `?memberId=${encodeURIComponent(memberToInspect)}`
      : "";
    const res = await fetch(`/api/admin/roles${q}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.roles)) setRoles(data.roles);
    if (Array.isArray(data.assignments)) setAssignments(data.assignments);
    if (Array.isArray(data.auditLog)) setAuditLog(data.auditLog);
    if (data.effectivePermissions) setEffectivePerms(data.effectivePermissions);
  }

  function startEditRole(role: RoleDefinitionRecord) {
    setEditingRoleId(role.roleId);
    setRoleName(role.name);
    setRoleDescription(role.description);
    setRoleScope(role.scope);
    setSelectedPerms(new Set(role.permissions));
    setRoleStatus(null);
  }

  function resetRoleEditor() {
    setEditingRoleId("");
    setRoleName("");
    setRoleDescription("");
    setRoleScope("branch");
    setSelectedPerms(new Set());
    setRoleStatus(null);
  }

  function togglePerm(key: PermissionKey, checked: boolean) {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleScopeChange(nextScope: PermissionScope) {
    setRoleScope(nextScope);
    if (nextScope === "branch") {
      setSelectedPerms((prev) => {
        const next = new Set<PermissionKey>();
        for (const key of prev) {
          const def = catalogue.find((c) => c.key === key);
          if (def?.allowedScopes.includes("branch")) next.add(key);
        }
        return next;
      });
    }
  }

  async function handleSaveRole(event: React.FormEvent) {
    event.preventDefault();
    setSavingRole(true);
    setRoleStatus(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save_role",
          ...(editingRoleId ? { roleId: editingRoleId } : {}),
          name: roleName,
          description: roleDescription,
          scope: roleScope,
          permissions: [...selectedPerms],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not save role.");
      }
      await refreshAll(inspectMemberId);
      resetRoleEditor();
      setRoleStatus({ kind: "ok", text: "Role saved." });
    } catch (error) {
      setRoleStatus({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not save role.",
      });
    } finally {
      setSavingRole(false);
    }
  }

  async function handleDeleteRole(roleId: string) {
    setRoleStatus(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not delete role.");
      await refreshAll(inspectMemberId);
      if (editingRoleId === roleId) resetRoleEditor();
      setRoleStatus({ kind: "ok", text: "Role deleted." });
    } catch (error) {
      setRoleStatus({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not delete role.",
      });
    }
  }

  async function handleAssignRole(event: React.FormEvent) {
    event.preventDefault();
    setSavingAssign(true);
    setAssignStatus(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "assign_role",
          memberId: assignMemberId,
          roleId: assignRoleId,
          branchId:
            selectedAssignRole?.scope === "branch" ? assignBranchId : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not assign role.");
      await refreshAll(inspectMemberId);
      setAssignStatus({ kind: "ok", text: "Role assigned." });
    } catch (error) {
      setAssignStatus({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not assign role.",
      });
    } finally {
      setSavingAssign(false);
    }
  }

  async function handleRevokeAssignment(assignmentId: string) {
    const reason = window.prompt(
      "Give a short reason for revoking this role assignment:",
      "Role no longer required",
    );
    if (!reason || reason.trim().length < 3) return;
    setAssignStatus(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId, reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not revoke role.");
      await refreshAll(inspectMemberId);
      setAssignStatus({ kind: "ok", text: "Role assignment revoked." });
    } catch (error) {
      setAssignStatus({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not revoke role.",
      });
    }
  }

  async function handleInspectMember(memberId: string) {
    setInspectMemberId(memberId);
    if (!memberId) {
      setEffectivePerms(null);
      return;
    }
    setLoadingInspect(true);
    try {
      await refreshAll(memberId);
    } finally {
      setLoadingInspect(false);
    }
  }

  const activeAssignments = assignments.filter((a) => a.status === "active");

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Role definitions
          </CardTitle>
          <CardDescription>
            Built-in system roles preserve existing governance authority. Create
            custom roles to delegate routine tasks without granting full
            administrator access.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.roleId}>
                  <TableCell>
                    <div className="font-medium">{role.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {role.description || "No description"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={role.scope === "national" ? "info" : "outline"}
                    >
                      {role.scope === "national" ? "National" : "Branch"}
                    </Badge>
                    {role.isSystem && (
                      <Badge variant="muted" className="ml-1">
                        System
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {role.permissions.length}
                  </TableCell>
                  <TableCell className="text-right">
                    {!role.isSystem ? (
                      <div className="inline-flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => startEditRole(role)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteRole(role.roleId)}
                          aria-label={`Delete ${role.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {role.scope === "branch"
                          ? "Assigned in Branches"
                          : "Assigned in Members"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {editingRoleId ? "Edit custom role" : "Create custom role"}
          </CardTitle>
          <CardDescription>
            Branch-scoped roles cannot include National-only permissions such as
            policy ratification or identifiable ballot access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveRole} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Role name" htmlFor="role-name">
                <Input
                  id="role-name"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="e.g. Branch Ballot Officer"
                />
              </Field>
              <Field label="Scope" htmlFor="role-scope">
                <NativeSelect
                  id="role-scope"
                  value={roleScope}
                  onChange={(e) =>
                    handleScopeChange(e.target.value as PermissionScope)
                  }
                >
                  <option value="branch">Branch-scoped</option>
                  <option value="national">National</option>
                </NativeSelect>
              </Field>
              <Field label="Description (optional)" htmlFor="role-desc">
                <Input
                  id="role-desc"
                  value={roleDescription}
                  onChange={(e) => setRoleDescription(e.target.value)}
                  maxLength={300}
                  placeholder="What this role is responsible for"
                />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {groupedCatalogue.map(([group, defs]) => (
                <div
                  key={group}
                  className="rounded-lg border border-border p-3 grid gap-2"
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  {defs.map((def) => {
                    const allowed = def.allowedScopes.includes(roleScope);
                    const checked = selectedPerms.has(def.key);
                    return (
                      <label
                        key={def.key}
                        className={`flex items-start gap-2.5 text-sm ${
                          allowed ? "cursor-pointer" : "opacity-50"
                        }`}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!allowed}
                          onChange={(e) =>
                            togglePerm(def.key, e.target.checked)
                          }
                          aria-label={def.label}
                        />
                        <span className="grid gap-0.5">
                          <span className="font-medium flex flex-wrap items-center gap-1.5">
                            {def.label}
                            {def.sensitive && (
                              <Badge variant="warning">Sensitive</Badge>
                            )}
                            {!allowed && (
                              <Badge variant="outline">National only</Badge>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {def.description}
                            {def.sensitivityNote
                              ? ` ${def.sensitivityNote}`
                              : ""}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>

            {roleStatus && (
              <Alert
                variant={roleStatus.kind === "err" ? "destructive" : "default"}
              >
                <AlertTitle>
                  {roleStatus.kind === "err" ? "Could not save" : "Saved"}
                </AlertTitle>
                <AlertDescription>{roleStatus.text}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={savingRole}>
                {savingRole
                  ? "Saving…"
                  : editingRoleId
                    ? "Save role changes"
                    : "Create role"}
              </Button>
              {editingRoleId && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetRoleEditor}
                >
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="size-4" aria-hidden="true" />
            Assign custom role
          </CardTitle>
          <CardDescription>
            You can only assign roles whose permissions you hold. Self-assignment
            and self-revocation are blocked.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {assignableRoles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a custom role above before assigning it to a member.
            </p>
          ) : (
            <form
              onSubmit={handleAssignRole}
              className="grid gap-4 sm:grid-cols-3 items-end"
            >
              <Field label="Member" htmlFor="assign-member">
                <NativeSelect
                  id="assign-member"
                  value={assignMemberId}
                  onChange={(e) => setAssignMemberId(e.target.value)}
                  required
                >
                  <option value="">Choose a member…</option>
                  {members.map((m) => (
                    <option key={m.memberId} value={m.memberId}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Custom role" htmlFor="assign-role">
                <NativeSelect
                  id="assign-role"
                  value={assignRoleId}
                  onChange={(e) => setAssignRoleId(e.target.value)}
                  required
                >
                  <option value="">Choose a role…</option>
                  {assignableRoles.map((r) => (
                    <option key={r.roleId} value={r.roleId}>
                      {r.name} ({r.scope})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {selectedAssignRole?.scope === "branch" ? (
                <Field label="Branch" htmlFor="assign-branch">
                  <NativeSelect
                    id="assign-branch"
                    value={assignBranchId}
                    onChange={(e) => setAssignBranchId(e.target.value)}
                    required
                  >
                    <option value="">Choose a branch…</option>
                    {branches.map((b) => (
                      <option key={b.branchId} value={b.branchId}>
                        {b.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : (
                <div>
                  <Button type="submit" disabled={savingAssign}>
                    {savingAssign ? "Assigning…" : "Assign role"}
                  </Button>
                </div>
              )}
              {selectedAssignRole?.scope === "branch" && (
                <div>
                  <Button type="submit" disabled={savingAssign}>
                    {savingAssign ? "Assigning…" : "Assign branch role"}
                  </Button>
                </div>
              )}
            </form>
          )}

          {assignStatus && (
            <Alert
              variant={assignStatus.kind === "err" ? "destructive" : "default"}
            >
              <AlertTitle>
                {assignStatus.kind === "err" ? "Action blocked" : "Updated"}
              </AlertTitle>
              <AlertDescription>{assignStatus.text}</AlertDescription>
            </Alert>
          )}

          {activeAssignments.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeAssignments.map((a) => (
                  <TableRow key={a.assignmentId}>
                    <TableCell>{memberName(a.memberId)}</TableCell>
                    <TableCell>{roleNameById(a.roleId)}</TableCell>
                    <TableCell>{branchName(a.branchId)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleRevokeAssignment(a.assignmentId)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4" aria-hidden="true" />
            Effective permissions inspector
          </CardTitle>
          <CardDescription>
            Inspect a member&apos;s combined permissions across legacy roles,
            branch administrator delegations, and custom roles, including the
            exact origin of each grant.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Inspect member" htmlFor="inspect-member">
            <NativeSelect
              id="inspect-member"
              value={inspectMemberId}
              onChange={(e) => handleInspectMember(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {members.map((m) => (
                <option key={m.memberId} value={m.memberId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </NativeSelect>
          </Field>

          {loadingInspect ? (
            <p className="text-sm text-muted-foreground">
              Loading effective permissions…
            </p>
          ) : effectivePerms ? (
            effectivePerms.grants.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This member has no administrative permissions.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Permission</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Origin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {effectivePerms.grants.map((g, idx) => (
                    <TableRow
                      key={`${g.permission}-${g.roleId}-${g.branchId ?? "nat"}-${idx}`}
                    >
                      <TableCell className="font-mono text-xs">
                        {g.permission}
                      </TableCell>
                      <TableCell>{branchName(g.branchId)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{g.roleName}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a member to inspect their effective permissions and grant
              origins.
            </p>
          )}
        </CardContent>
      </Card>

      {auditLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent role audit log</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Scope</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditLog.slice(0, 15).map((entry, idx) => (
                  <TableRow key={entry.eventId ?? idx}>
                    <TableCell>{entry.action}</TableCell>
                    <TableCell>{entry.actorName ?? "Administrator"}</TableCell>
                    <TableCell>{roleNameById(entry.roleId)}</TableCell>
                    <TableCell>{memberName(entry.targetMemberId)}</TableCell>
                    <TableCell>{branchName(entry.branchId)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

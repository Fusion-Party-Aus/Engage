import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { Separator } from "../ui/separator.tsx";
import { Switch } from "../ui/switch.tsx";

export type NotificationTopic =
  | "new_ballots"
  | "closing_deadlines"
  | "contribution_responses"
  | "governance_outcomes"
  | "account_membership";

export interface UnifiedNotificationPreferences {
  email: Record<NotificationTopic, boolean>;
  push: Record<NotificationTopic, boolean>;
  generalCommunicationsEnabled: boolean;
  suppressed: boolean;
}

export interface InAppNotificationItem {
  notificationId: string;
  topic: NotificationTopic;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
}

export interface PushSubscriptionSummary {
  subscriptionId: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface TopicMeta {
  key: NotificationTopic;
  label: string;
  description: string;
}

const TOPICS: TopicMeta[] = [
  {
    key: "new_ballots",
    label: "New ballots",
    description: "When a formal ballot you can vote on opens.",
  },
  {
    key: "closing_deadlines",
    label: "Closing deadlines",
    description: "Reminders for eligible ballots closing within seven days.",
  },
  {
    key: "contribution_responses",
    label: "Contribution responses",
    description: "When an officer records an outcome on your deliberation comment.",
  },
  {
    key: "governance_outcomes",
    label: "Governance outcomes",
    description: "When a ballot you followed or voted on records a formal result.",
  },
  {
    key: "account_membership",
    label: "Account and membership",
    description: "Verification updates and branch membership changes.",
  },
];

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function detectDeviceLabel(): string {
  if (typeof navigator === "undefined") return "This browser";
  const ua = navigator.userAgent;
  if (/iPhone|iPad/i.test(ua)) return "iOS browser";
  if (/Android/i.test(ua)) return "Android browser";
  if (/Edg\//i.test(ua)) return "Microsoft Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Web browser";
}

export interface NotificationCenterProps {
  initialPreferences: UnifiedNotificationPreferences;
  initialNotifications: InAppNotificationItem[];
  initialSubscriptions: PushSubscriptionSummary[];
  pushConfigured: boolean;
  vapidPublicKey: string | null;
}

export function NotificationCenter({
  initialPreferences,
  initialNotifications,
  initialSubscriptions,
  pushConfigured,
  vapidPublicKey,
}: NotificationCenterProps) {
  const [preferences, setPreferences] = useState<UnifiedNotificationPreferences>(initialPreferences);
  const [notifications, setNotifications] = useState<InAppNotificationItem[]>(initialNotifications);
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionSummary[]>(initialSubscriptions);
  const [savingPref, setSavingPref] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<string>("unsupported");

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator) {
      setPermissionState(Notification.permission);
    }
  }, []);

  const unreadCount = notifications.filter((item) => !item.readAt).length;
  const pushReady = pushConfigured && subscriptions.length > 0;

  async function updatePreference(payload: {
    email?: Partial<Record<NotificationTopic, boolean>>;
    push?: Partial<Record<NotificationTopic, boolean>>;
    generalCommunicationsEnabled?: boolean;
  }) {
    setSavingPref(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const previous = preferences;

    setPreferences((curr) => ({
      ...curr,
      email: { ...curr.email, ...(payload.email ?? {}) },
      push: { ...curr.push, ...(payload.push ?? {}) },
      generalCommunicationsEnabled:
        payload.generalCommunicationsEnabled ?? curr.generalCommunicationsEnabled,
    }));

    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreferences(previous);
        setErrorMessage(data.error ?? "Couldn't save notification preferences. Try again.");
        return;
      }
      if (data.preferences) {
        setPreferences(data.preferences);
      }
      setStatusMessage("Preferences updated.");
    } catch {
      setPreferences(previous);
      setErrorMessage("Couldn't save notification preferences. Try again.");
    } finally {
      setSavingPref(false);
    }
  }

  async function markRead(notificationId: string) {
    setInboxBusy(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark_read", notificationId }),
      });
      if (!res.ok) throw new Error("Failed");
      const nowIso = new Date().toISOString();
      setNotifications((curr) =>
        curr.map((item) =>
          item.notificationId === notificationId ? { ...item, readAt: item.readAt ?? nowIso } : item,
        ),
      );
    } catch {
      setErrorMessage("Couldn't update notification status.");
    } finally {
      setInboxBusy(false);
    }
  }

  async function markAllRead() {
    setInboxBusy(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark_all_read" }),
      });
      if (!res.ok) throw new Error("Failed");
      const nowIso = new Date().toISOString();
      setNotifications((curr) => curr.map((item) => ({ ...item, readAt: item.readAt ?? nowIso })));
    } catch {
      setErrorMessage("Couldn't mark notifications as read.");
    } finally {
      setInboxBusy(false);
    }
  }

  async function enablePushOnDevice() {
    if (!pushConfigured || !vapidPublicKey) {
      setErrorMessage("Push notifications are not configured on this server.");
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setErrorMessage("This browser doesn't support web push notifications.");
      return;
    }

    setPushBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const permission = await Notification.requestPermission();
      setPermissionState(permission);
      if (permission !== "granted") {
        setErrorMessage(
          permission === "denied"
            ? "Notifications are blocked for this site in your browser settings."
            : "Browser permission was dismissed.",
        );
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }));

      const res = await fetch("/api/notifications/push-subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          deviceLabel: detectDeviceLabel(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error ?? "Couldn't register this device for push notifications.");
        return;
      }
      if (Array.isArray(data.subscriptions)) {
        setSubscriptions(data.subscriptions);
      }
      setStatusMessage("This device is now registered for push notifications.");
    } catch {
      setErrorMessage("Couldn't enable push notifications on this device.");
    } finally {
      setPushBusy(false);
    }
  }

  async function removeSubscription(subscriptionId: string) {
    setPushBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/notifications/push-subscription", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscriptionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error ?? "Couldn't remove device.");
        return;
      }
      if (Array.isArray(data.subscriptions)) {
        setSubscriptions(data.subscriptions);
      }
      setStatusMessage("Device removed.");
    } catch {
      setErrorMessage("Couldn't remove device.");
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      {errorMessage && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      {statusMessage && (
        <Alert>
          <AlertDescription role="status">{statusMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Notification inbox</CardTitle>
            <CardDescription>Recent ballot, deliberation, and account updates.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={unreadCount > 0 ? "info" : "muted"}>
              {unreadCount} unread
            </Badge>
            {unreadCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={inboxBusy}
                onClick={markAllRead}
              >
                Mark all read
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {notifications.length === 0 ? (
            <p className="text-sm text-muted-foreground m-0">You're up to date.</p>
          ) : (
            <ul className="grid gap-3 list-none p-0 m-0">
              {notifications.map((item) => (
                <li
                  key={item.notificationId}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 bg-background"
                >
                  <div className="grid gap-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={item.href} className="font-semibold text-sm hover:underline">
                        {item.title}
                      </a>
                      {!item.readAt && <Badge variant="info">New</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground m-0">{item.body}</p>
                    <small className="text-xs text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </small>
                  </div>
                  {!item.readAt && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={inboxBusy}
                      onClick={() => markRead(item.notificationId)}
                    >
                      Mark read
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email &amp; push preferences</CardTitle>
          <CardDescription>
            Choose which updates reach your inbox or browser. Push notifications are never turned on without your permission.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {preferences.suppressed && (
            <Alert variant="warning">
              <AlertTitle>Email delivery paused</AlertTitle>
              <AlertDescription>
                Email delivery was paused after a bounce or spam complaint. Contact an administrator to restore email delivery.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-3">
            {TOPICS.map((topic) => (
              <div
                key={topic.key}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-3 bg-background"
              >
                <div className="grid gap-0.5 min-w-0 flex-1">
                  <span className="font-medium text-sm">{topic.label}</span>
                  <span className="text-xs text-muted-foreground">{topic.description}</span>
                </div>
                <div className="flex items-center gap-5">
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <Switch
                      checked={preferences.email[topic.key]}
                      disabled={preferences.suppressed || savingPref}
                      aria-label={`${topic.label} by email`}
                      onCheckedChange={(checked) =>
                        updatePreference({ email: { [topic.key]: checked } })
                      }
                    />
                    <span>Email</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <Switch
                      checked={preferences.push[topic.key]}
                      disabled={!pushReady || savingPref}
                      aria-label={`${topic.label} by push`}
                      onCheckedChange={(checked) =>
                        updatePreference({ push: { [topic.key]: checked } })
                      }
                    />
                    <span>Push</span>
                  </label>
                </div>
              </div>
            ))}
          </div>

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="grid gap-0.5">
              <span className="font-medium text-sm">Fusion updates &amp; events</span>
              <span className="text-xs text-muted-foreground">
                General party communications outside formal Engage ballots.
              </span>
            </div>
            <Switch
              checked={preferences.generalCommunicationsEnabled}
              disabled={preferences.suppressed || savingPref}
              aria-label="Fusion updates and events by email"
              onCheckedChange={(checked) =>
                updatePreference({ generalCommunicationsEnabled: checked })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Browser push on this device</CardTitle>
            <CardDescription>
              Receive ballot deadline and response alerts even when Engage is closed.
            </CardDescription>
          </div>
          {pushConfigured ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pushBusy || permissionState === "denied" || permissionState === "unsupported"}
              onClick={enablePushOnDevice}
            >
              {pushBusy ? "Enabling..." : "Enable push on this device"}
            </Button>
          ) : (
            <Badge variant="muted">Server setup pending</Badge>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {permissionState === "denied" && (
            <Alert variant="warning">
              <AlertDescription>
                Notifications are blocked for this site in your browser settings. Allow notifications in your browser to subscribe.
              </AlertDescription>
            </Alert>
          )}

          {subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground m-0">
              No devices registered for push notifications yet.
            </p>
          ) : (
            <ul className="grid gap-2 list-none p-0 m-0">
              {subscriptions.map((sub) => (
                <li
                  key={sub.subscriptionId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 bg-background"
                >
                  <div className="grid gap-0.5">
                    <span className="font-medium text-sm">{sub.deviceLabel}</span>
                    <small className="text-xs text-muted-foreground">
                      Added {formatDate(sub.createdAt)}
                      {sub.lastUsedAt ? ` · Last delivered ${formatDate(sub.lastUsedAt)}` : ""}
                    </small>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pushBusy}
                    onClick={() => removeSubscription(sub.subscriptionId)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

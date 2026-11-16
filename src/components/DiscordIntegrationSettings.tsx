import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Switch } from "./ui/switch";
import { ConfirmDialog, SectionCard, type ConfirmRequest } from "./admin-kit";

interface SettingsSummary {
  enabled: boolean;
  liveWebhookConfigured: boolean;
  testWebhookConfigured: boolean;
  liveRoleId: string;
  testRoleId: string;
  dayOfWeek: number;
  hourOfDay: number;
  updatedByName: string | null;
}

interface SettingsForm {
  enabled: boolean;
  liveWebhookUrl: string;
  testWebhookUrl: string;
  liveRoleId: string;
  testRoleId: string;
  dayOfWeek: number;
  hourOfDay: number;
}

const days = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];
const defaultForm: SettingsForm = {
  enabled: false,
  liveWebhookUrl: "",
  testWebhookUrl: "",
  liveRoleId: "",
  testRoleId: "",
  dayOfWeek: 1,
  hourOfDay: 18,
};

function asForm(config: SettingsSummary): SettingsForm {
  return {
    ...defaultForm,
    enabled: config.enabled,
    liveRoleId: config.liveRoleId,
    testRoleId: config.testRoleId,
    dayOfWeek: config.dayOfWeek,
    hourOfDay: config.hourOfDay,
  };
}

async function requestJson(url: string, method: "GET" | "PATCH" | "POST" = "GET", body?: unknown): Promise<any> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(method !== "GET"
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }
      : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't complete this action.");
  return data;
}

export default function DiscordIntegrationSettings() {
  const [config, setConfig] = useState<SettingsSummary | null>(null);
  const [form, setForm] = useState<SettingsForm>(defaultForm);
  const [busy, setBusy] = useState<"save" | "preview" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [preview, setPreview] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const showError = (error: unknown) => {
    setNotice({
      error: true,
      text: error instanceof Error ? error.message : "Couldn't complete this action.",
    });
  };

  useEffect(() => {
    let active = true;
    requestJson("/api/admin/discord-settings")
      .then((data) => {
        if (!active) return;
        setConfig(data.config as SettingsSummary);
        setForm(asForm(data.config as SettingsSummary));
      })
      .catch((error) => { if (active) showError(error); });
    return () => { active = false; };
  }, []);

  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const persist = async (payload: Record<string, unknown>) => {
    const data = await requestJson("/api/admin/discord-settings", "PATCH", payload);
    const next = data.config as SettingsSummary;
    setConfig(next);
    setForm(asForm(next));
    return next;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !config) return;
    setBusy("save");
    setNotice(null);
    try {
      await persist({
        enabled: form.enabled,
        liveRoleId: form.liveRoleId,
        testRoleId: form.testRoleId,
        dayOfWeek: form.dayOfWeek,
        hourOfDay: form.hourOfDay,
        ...(form.liveWebhookUrl.trim() ? { liveWebhookUrl: form.liveWebhookUrl.trim() } : {}),
        ...(form.testWebhookUrl.trim() ? { testWebhookUrl: form.testWebhookUrl.trim() } : {}),
      });
      setNotice({ text: "Discord settings saved." });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  };

  const remove = (type: "live" | "test") => {
    if (busy || !config) return;
    setConfirm({
      title: `Remove the ${type} Discord webhook?`,
      description: type === "live"
        ? "Live weekly posting will be switched off. The test webhook will be unaffected."
        : "The test webhook will be removed. The live webhook will be unaffected.",
      confirmLabel: "Remove webhook",
      destructive: true,
      onConfirm: async () => {
        setBusy("remove");
        try {
          await persist(type === "live"
            ? { clearLiveWebhook: true }
            : { clearTestWebhook: true });
          setNotice({ text: `The ${type} webhook was removed.` });
        } catch (error) {
          showError(error);
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const showPreview = async () => {
    if (busy) return;
    setBusy("preview");
    try {
      const data = await requestJson("/api/admin/discord-digest");
      setPreview(String(data.content ?? ""));
      setNotice({ text: `Preview ready · ${Number(data.featured) || 0} proposals. Nothing sent.` });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    if (busy || !config?.testWebhookConfigured) return;
    setBusy("test");
    try {
      const result = await requestJson("/api/admin/discord-digest", "POST");
      if (result.status === "sent") setNotice({ text: "Discord confirmed receipt in the test server." });
      else if (result.status === "already-attempted")
        setNotice({ text: "A test was already attempted this minute. Check Discord before resending." });
      else setNotice({
        text: "Delivery couldn't be confirmed. Check the test channel before trying again.",
        error: true,
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      id="discord"
      title="Discord"
      description="Bring overlooked proposals to members' attention once a week."
    >
      <div className="grid gap-5 p-5">
        {!config ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice?.text ?? "Loading Discord settings…"}
          </p>
        ) : (
          <>
            <form onSubmit={save} className="grid gap-5">
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Test server</h3>
                <p className="text-xs text-muted-foreground">
                  Use a separate Discord server to check formatting and links before posting publicly.
                </p>
                <label htmlFor="discord-test-webhook" className="text-sm font-medium">
                  Test webhook URL
                </label>
                <Input
                  id="discord-test-webhook"
                  type="password"
                  autoComplete="off"
                  placeholder={config.testWebhookConfigured ? "Saved securely · enter to replace" : "Paste a test channel webhook"}
                  value={form.testWebhookUrl}
                  onChange={(event) => update("testWebhookUrl", event.target.value)}
                />
                {config.testWebhookConfigured && (
                  <div><Button type="button" size="sm" variant="outline" onClick={() => void remove("test")} disabled={!!busy}>
                    Remove test webhook
                  </Button></div>
                )}
                <label htmlFor="discord-test-role" className="text-sm font-medium">
                  Test role ID (optional)
                </label>
                <Input
                  id="discord-test-role"
                  inputMode="numeric"
                  value={form.testRoleId}
                  onChange={(event) => update("testRoleId", event.target.value)}
                  placeholder="Discord numeric role ID"
                />
              </div>
              <div className="grid gap-2 border-t pt-4">
                <h3 className="text-sm font-semibold">Live server</h3>
                <label htmlFor="discord-live-webhook" className="text-sm font-medium">
                  Live webhook URL
                </label>
                <Input
                  id="discord-live-webhook"
                  type="password"
                  autoComplete="off"
                  placeholder={config.liveWebhookConfigured ? "Saved securely · enter to replace" : "Paste the live channel webhook"}
                  value={form.liveWebhookUrl}
                  onChange={(event) => update("liveWebhookUrl", event.target.value)}
                />
                {config.liveWebhookConfigured && (
                  <div><Button type="button" size="sm" variant="outline" onClick={() => void remove("live")} disabled={!!busy}>
                    Remove live webhook
                  </Button></div>
                )}
                <label htmlFor="discord-live-role" className="text-sm font-medium">
                  Role to mention (@Tuned)
                </label>
                <Input
                  id="discord-live-role"
                  inputMode="numeric"
                  value={form.liveRoleId}
                  onChange={(event) => update("liveRoleId", event.target.value)}
                  placeholder="Numeric @Tuned role ID"
                />
              </div>
              <div className="grid gap-3 border-t pt-4">
                <h3 className="text-sm font-semibold">Weekly schedule</h3>
                <p className="text-xs text-muted-foreground">
                  Melbourne time. An hourly external trigger is still required, but the posting day and hour are set here.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label htmlFor="discord-day" className="text-sm font-medium">Day</label>
                    <NativeSelect
                      id="discord-day"
                      value={String(form.dayOfWeek)}
                      onChange={(event) => update("dayOfWeek", Number(event.target.value))}
                    >
                      {days.map((day, i) => <option key={day} value={i + 1}>{day}</option>)}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <label htmlFor="discord-hour" className="text-sm font-medium">From</label>
                    <NativeSelect
                      id="discord-hour"
                      value={String(form.hourOfDay)}
                      onChange={(event) => update("hourOfDay", Number(event.target.value))}
                    >
                      {Array.from({ length: 24 }, (_, hour) => (
                        <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t pt-4">
                  <div>
                    <label htmlFor="discord-enabled" className="text-sm font-semibold">Post weekly digests</label>
                    <p className="text-xs text-muted-foreground">Off by default. Requires the live webhook and @Tuned role.</p>
                  </div>
                  <Switch
                    id="discord-enabled"
                    checked={form.enabled}
                    onCheckedChange={(checked) => update("enabled", checked)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!!busy}>
                  {busy === "save" ? "Saving…" : "Save Discord settings"}
                </Button>
              </div>
            </form>
            <div className="grid gap-3 border-t pt-4">
              <h3 className="text-sm font-semibold">Preview and test</h3>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void showPreview()}>
                  Preview digest
                </Button>
                <Button type="button" disabled={!!busy || !config.testWebhookConfigured} onClick={() => void sendTest()}>
                  Send to test Discord
                </Button>
              </div>
              {preview && (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/50 p-3 text-sm">
                  {preview}
                </pre>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Webhook URLs are encrypted and never shown again. Settings changes are recorded without storing secrets in change history.
            </p>
          </>
        )}
        {notice && (
          <p role="status" aria-live="polite"
            className={notice.error
              ? "text-sm font-medium [color:var(--horizon-danger-ink)]"
              : "text-sm [color:var(--horizon-success-ink)]"}>
            {notice.text}
          </p>
        )}
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </SectionCard>
  );
}

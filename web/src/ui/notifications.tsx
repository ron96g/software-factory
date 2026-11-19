"use client";
import { ActionIcon, Anchor, Badge, Button, Checkbox, Divider, Group, Indicator, Popover, ScrollArea, SegmentedControl, Stack, Switch, Text, ThemeIcon, Tooltip, UnstyledButton } from "@mantine/core";
import { notifications as toasts } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconBell,
  IconBulb,
  IconChecklist,
  IconCircleCheck,
  IconClockPause,
  IconCloudUpload,
  IconGitPullRequest,
  IconMessage,
  IconMessageQuestion,
  IconRefresh,
  IconRepeat,
  IconSettings,
  IconTicket,
  IconX,
} from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FactoryNotification, NotificationSeverity } from "@/core/ports/notifications.ts";
import { api, ensureSource, onConnect, onNotification } from "./api.ts";
import { addNotifications, catchUpCursor, currentSettings, markAllRead, markRead, needsBaseline, updateSettings, useNotificationState } from "./notification-store.ts";

const SEVERITY_COLOR: Record<NotificationSeverity, string> = { action: "orange", problem: "red", info: "teal" };
const AUTO_CLOSE: Record<NotificationSeverity, number | false> = { action: false, problem: 10_000, info: 5_000 };
const COALESCE_MS = 5_000;

const CATEGORY_ICON: Record<string, typeof IconBell> = {
  clarification: IconMessageQuestion,
  approval: IconChecklist,
  attention: IconAlertTriangle,
  knowledge: IconBulb,
  issue: IconTicket,
  failed: IconX,
  loop: IconRepeat,
  quota: IconClockPause,
  controller: IconRefresh,
  "write-back": IconCloudUpload,
  done: IconCircleCheck,
  answered: IconMessage,
  "pull-request": IconGitPullRequest,
  sync: IconRefresh,
  chat: IconMessage,
};
const iconFor = (n: FactoryNotification) => CATEGORY_ICON[n.category] ?? (n.severity === "info" ? IconBell : IconAlertTriangle);

const isExternal = (link: string) => /^https?:\/\//.test(link);
const pathOf = (link: string) => link.split(/[?#]/)[0];

function useOpenNotification() {
  const router = useRouter();
  return (n: FactoryNotification) => {
    markRead(n.id);
    toasts.hide(`sf-n-${n.id}`);
    if (isExternal(n.link)) window.open(n.link, "_blank", "noopener");
    else router.push(n.link);
  };
}

function relativeTime(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

const desktopSupport = (): { ok: boolean; reason?: string } => {
  if (typeof window === "undefined" || !("Notification" in window)) return { ok: false, reason: "This browser doesn't support desktop notifications." };
  if (!window.isSecureContext) return { ok: false, reason: "Desktop notifications need HTTPS or localhost." };
  return { ok: true };
};

/**
 * Turns `notification` frames into toasts, desktop notifications and the tab title, and catches up on
 * reconnect (ADR-0069 §4–5). Mounted once in the shell.
 */
export function NotificationBridge() {
  const open = useOpenNotification();
  const openRef = useRef(open);
  openRef.current = open;
  const { unread } = useNotificationState();

  useEffect(() => {
    ensureSource();
    const recent = new Map<string, { toastId: string; count: number; t: number }>();

    const toast = (n: FactoryNotification) => {
      const key = `${n.workItem ?? n.link}|${n.category}`;
      const prev = recent.get(key);
      const Icon = iconFor(n);
      const body = (count: number) => (
        <Stack gap={4}>
          <Text size="sm">
            {n.message}
            {count > 1 ? ` (+${count - 1} more)` : ""}
          </Text>
          <Anchor size="sm" component="button" type="button" onClick={() => openRef.current(n)}>
            {isExternal(n.link) ? "Open pull request" : "Open"}
          </Anchor>
        </Stack>
      );
      if (prev && Date.now() - prev.t < COALESCE_MS) {
        prev.count++;
        prev.t = Date.now();
        toasts.update({ id: prev.toastId, title: n.title, message: body(prev.count), color: SEVERITY_COLOR[n.severity], icon: <Icon size={16} />, autoClose: AUTO_CLOSE[n.severity] });
        return;
      }
      const toastId = `sf-n-${n.id}`;
      recent.set(key, { toastId, count: 1, t: Date.now() });
      toasts.show({
        id: toastId,
        title: n.title,
        message: body(1),
        color: SEVERITY_COLOR[n.severity],
        icon: <Icon size={16} />,
        autoClose: AUTO_CLOSE[n.severity],
        withBorder: true,
        // Mantine defaults to role="alert" (assertive); info should not interrupt a screen reader.
        role: n.severity === "info" ? "status" : "alert",
      });
    };

    const desktop = (n: FactoryNotification) => {
      const s = currentSettings();
      if (!s.desktop || !s.desktopSeverities.includes(n.severity) || !desktopSupport().ok || Notification.permission !== "granted") return;
      // Only the title and the item's title: the OS may show this on a lock screen.
      const dn = new Notification(n.title, { body: n.subject ?? "", tag: n.id });
      dn.onclick = () => {
        window.focus();
        openRef.current(n);
        dn.close();
      };
    };

    const deliver = (n: FactoryNotification) => {
      const hidden = document.visibilityState !== "visible";
      if (hidden) desktop(n);
      if (n.severity === "info" && !hidden && !isExternal(n.link) && pathOf(n.link) === window.location.pathname) return;
      toast(n);
    };

    let initial = true;
    let inFlight = false;
    const catchUp = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const cursor = catchUpCursor();
        const first = initial;
        initial = false;
        const url = first || !cursor ? "/api/notifications?limit=50" : `/api/notifications?since=${encodeURIComponent(cursor)}&limit=200`;
        const baseline = needsBaseline();
        const added = addNotifications(await api<FactoryNotification[]>(url), { baseline });
        // Reloads and reconnects never replay a burst of toasts: one summary when humans are needed.
        const missed = baseline ? [] : added.filter((n) => !cursor || n.at > cursor);
        if (missed.length === 1) deliver(missed[0]);
        else if (missed.length > 1) {
          const actions = missed.filter((n) => n.severity === "action").length;
          if (actions) {
            toasts.show({
              id: "sf-n-summary",
              title: `${actions} item${actions === 1 ? " needs" : "s need"} you`,
              message: `${missed.length} notifications while you were away. Open the bell to see them.`,
              color: SEVERITY_COLOR.action,
              icon: <IconBell size={16} />,
              autoClose: false,
              withBorder: true,
            });
          }
        }
      } catch {
        // The next reconnect retries; live frames keep arriving meanwhile.
      } finally {
        inFlight = false;
      }
    };

    void catchUp();
    const offConnect = onConnect(() => void catchUp());
    const offNotification = onNotification((n) => {
      if (addNotifications([n]).length) deliver(n);
    });
    return () => {
      offConnect();
      offNotification();
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\) /, "");
      const next = unread ? `(${unread}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    // Next.js rewrites the title on navigation; re-apply the unread prefix afterwards.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [unread]);

  return null;
}

type Filter = "all" | "action" | "problem";

function DesktopSettings() {
  const { settings } = useNotificationState();
  const support = desktopSupport();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  useEffect(() => setPermission(support.ok ? Notification.permission : "unsupported"), [support.ok]);

  const toggle = async (on: boolean) => {
    if (!on) return updateSettings({ desktop: false });
    // Asked only from this click: browsers block (and users hate) prompts on page load.
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setPermission(p);
    updateSettings({ desktop: p === "granted" });
  };

  return (
    <Stack gap={6}>
      <Switch
        size="sm"
        label="Desktop notifications"
        description="Shown while this tab is in the background"
        checked={settings.desktop && permission === "granted"}
        disabled={!support.ok || permission === "denied"}
        onChange={(e) => void toggle(e.currentTarget.checked)}
      />
      {!support.ok && <Text size="xs" c="dimmed">{support.reason}</Text>}
      {permission === "denied" && <Text size="xs" c="dimmed">Blocked in the browser&apos;s site settings.</Text>}
      {settings.desktop && permission === "granted" && (
        <Checkbox
          size="xs"
          label="Also for info (done, PR opened, …)"
          checked={settings.desktopSeverities.includes("info")}
          onChange={(e) => updateSettings({ desktopSeverities: e.currentTarget.checked ? ["action", "problem", "info"] : ["action", "problem"] })}
        />
      )}
    </Stack>
  );
}

/** Header bell: unread count, history list, mark read, desktop opt-in. */
export function NotificationBell() {
  const { items, unread, isUnread } = useNotificationState();
  const open = useOpenNotification();
  const [opened, setOpened] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [showSettings, setShowSettings] = useState(false);
  const shown = useMemo(() => (filter === "all" ? items : items.filter((n) => n.severity === filter)), [items, filter]);

  return (
    <Popover opened={opened} onChange={setOpened} width={400} position="bottom-end" shadow="md" withArrow trapFocus>
      <Popover.Target>
        <Indicator label={unread > 99 ? "99+" : unread} size={16} disabled={!unread} color="orange" offset={4}>
          <ActionIcon variant="subtle" color="gray" size="lg" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpened((o) => !o)}>
            <IconBell size={18} stroke={1.6} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p="sm">
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={600} size="sm">
              Notifications
            </Text>
            <Group gap={4}>
              <Button size="compact-xs" variant="subtle" disabled={!unread} onClick={markAllRead}>
                Mark all read
              </Button>
              <Tooltip label="Settings">
                <ActionIcon size="sm" variant={showSettings ? "light" : "subtle"} color="gray" aria-label="Notification settings" onClick={() => setShowSettings((s) => !s)}>
                  <IconSettings size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
          {showSettings && (
            <>
              <DesktopSettings />
              <Divider />
            </>
          )}
          <SegmentedControl
            size="xs"
            fullWidth
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            data={[
              { value: "all", label: "All" },
              { value: "action", label: "Needs you" },
              { value: "problem", label: "Problems" },
            ]}
          />
          <ScrollArea.Autosize mah={420} type="auto">
            {shown.length === 0 ? (
              <Text size="sm" c="dimmed" ta="center" py="lg">
                Nothing here yet.
              </Text>
            ) : (
              <Stack gap={2}>
                {shown.map((n) => {
                  const Icon = iconFor(n);
                  const fresh = isUnread(n);
                  return (
                    <UnstyledButton
                      key={n.id}
                      className="sf-notification-row"
                      onClick={() => {
                        setOpened(false);
                        open(n);
                      }}
                      p={6}
                      style={{ borderRadius: "var(--mantine-radius-sm)" }}
                    >
                      <Group gap="sm" wrap="nowrap" align="flex-start">
                        <ThemeIcon size="md" variant="light" color={SEVERITY_COLOR[n.severity]}>
                          <Icon size={14} />
                        </ThemeIcon>
                        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                          <Group gap={6} justify="space-between" wrap="nowrap">
                            <Text size="sm" fw={fresh ? 600 : 400} truncate>
                              {n.title}
                            </Text>
                            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                              {relativeTime(n.at)}
                            </Text>
                          </Group>
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            {n.message}
                          </Text>
                        </Stack>
                        {fresh && (
                          <Badge size="xs" circle color="orange" aria-label="unread">
                            {" "}
                          </Badge>
                        )}
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            )}
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

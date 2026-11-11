"use client";
import { Badge, type MantineColor } from "@mantine/core";
import type { RunPhase, WorkItemPhase } from "@/core/model/kinds.ts";

const PHASE_COLORS: Record<string, MantineColor> = {
  New: "gray",
  Running: "blue",
  Blocked: "orange",
  AwaitingApproval: "yellow",
  Done: "teal",
  Closed: "gray",
  Failed: "red",
  Pending: "gray",
  Preparing: "blue",
  Ready: "teal",
  Succeeded: "teal",
};

const LABELS: Record<string, string> = { AwaitingApproval: "Awaiting approval" };

export function PhaseBadge({ phase, size = "sm" }: { phase?: WorkItemPhase | RunPhase | string; size?: "xs" | "sm" | "md" }) {
  const p = phase ?? "New";
  return (
    <Badge color={PHASE_COLORS[p] ?? "gray"} variant="light" size={size}>
      {LABELS[p] ?? p}
    </Badge>
  );
}

const TYPE_COLORS: Record<string, MantineColor> = { bug: "red", incident: "pink", feature: "indigo", chore: "gray", question: "blue" };

export function TypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  return (
    <Badge color={TYPE_COLORS[type] ?? "gray"} variant="dot" size="sm">
      {type}
    </Badge>
  );
}

export const timeAgo = (iso?: string) => {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

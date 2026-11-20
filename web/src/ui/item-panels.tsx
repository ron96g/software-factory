"use client";

import type { ReactNode } from "react";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import type { PlanningWorkspace as PlanningWorkspaceData } from "@/core/ports/planning.ts";
import PlanningWorkspace from "./planning-workspace.tsx";
import { CheckRunsPanel } from "./check-runs.tsx";
import { PullRequestPanel } from "./pull-request-panel.tsx";
import { RetrospectivePanel } from "./retrospectives.tsx";
import { TicketActionsPanel } from "./ticket-actions.tsx";
import { UnitProgressPanel } from "./unit-progress.tsx";
import { VerificationContractPanel } from "./verification-contract.tsx";

/** Where on the item page a panel goes, top to bottom (ADR-0075). */
export type ItemPanelRegion = "summary" | "attention" | "primary" | "operational";

export interface ItemPanelContext {
  detail: WorkItemDetail;
  /** Inception is over; construction progress is the main view. */
  constructing: boolean;
  planning: { data: PlanningWorkspaceData | null; error: string | null; reload: () => Promise<void> };
  onOpenRun: (run: string) => void;
}

/** A workflow-specific panel: shown only when the item has every capability in `requires` (ADR-0075). */
export interface ItemPanel {
  id: string;
  region: ItemPanelRegion;
  order: number;
  requires: string[];
  render(ctx: ItemPanelContext): ReactNode;
}

const key = (ctx: ItemPanelContext, id: string) => `${id}-${ctx.detail.workItem.metadata.uid ?? ctx.detail.workItem.metadata.name}`;

export const ITEM_PANELS: ItemPanel[] = [
  { id: "retrospective", region: "summary", order: 10, requires: ["retrospective"],
    render: (ctx) => <RetrospectivePanel key={key(ctx, "retrospective")} item={ctx.detail.workItem} /> },
  { id: "pull-requests", region: "attention", order: 10, requires: ["pull-requests"],
    render: (ctx) => <PullRequestPanel key={key(ctx, "prs")} d={ctx.detail} /> },
  { id: "ticket-actions", region: "attention", order: 20, requires: ["ticket-actions"],
    render: (ctx) => <TicketActionsPanel key={key(ctx, "tickets")} item={ctx.detail.workItem} /> },
  { id: "unit-progress", region: "attention", order: 30, requires: ["unit-execution"],
    render: (ctx) => ctx.constructing && <UnitProgressPanel key={key(ctx, "units")} item={ctx.detail.workItem} /> },
  { id: "planning", region: "primary", order: 10, requires: ["planning"],
    render: (ctx) => <PlanningWorkspace key={key(ctx, "planning")} workspace={ctx.planning.data} error={ctx.planning.error}
      reload={ctx.planning.reload} detail={ctx.detail} onOpenRun={ctx.onOpenRun} summary={ctx.constructing} /> },
  { id: "verification", region: "operational", order: 10, requires: ["verification"],
    render: (ctx) => <VerificationContractPanel key={key(ctx, "verification")} item={ctx.detail.workItem} /> },
  { id: "checks", region: "operational", order: 20, requires: ["checks"],
    render: (ctx) => <CheckRunsPanel key={key(ctx, "checks")} item={ctx.detail.workItem} /> },
];

/** The panels of a region that apply to this item, in order. */
export function itemPanels(region: ItemPanelRegion, ctx: ItemPanelContext, panels: ItemPanel[] = ITEM_PANELS): ItemPanel[] {
  const capabilities = new Set(ctx.detail.capabilities);
  return panels.filter((p) => p.region === region && p.requires.every((c) => capabilities.has(c))).sort((a, b) => a.order - b.order);
}

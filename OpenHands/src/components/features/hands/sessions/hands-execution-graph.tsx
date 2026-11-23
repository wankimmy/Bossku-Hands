import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSession, HandsSessionState } from "#/api/hands/hands-types";
import { cn } from "#/utils/utils";

type StageId =
  | "plan"
  | "approve_plan"
  | "code"
  | "review"
  | "approve_pr"
  | "open_pr"
  | "watch_ci"
  | "repair_ci"
  | "ready"
  | "merged";

type StageStatus =
  "done" | "current" | "waiting" | "failed" | "upcoming" | "skipped";

const STAGE_ORDER: readonly StageId[] = [
  "plan",
  "approve_plan",
  "code",
  "review",
  "approve_pr",
  "open_pr",
  "watch_ci",
  "repair_ci",
  "ready",
  "merged",
];

const STAGE_LABEL: Record<StageId, I18nKey> = {
  plan: I18nKey.HANDS$STAGE_PLAN,
  approve_plan: I18nKey.HANDS$STAGE_APPROVE_PLAN,
  code: I18nKey.HANDS$STAGE_CODE,
  review: I18nKey.HANDS$STAGE_REVIEW,
  approve_pr: I18nKey.HANDS$STAGE_APPROVE_PR,
  open_pr: I18nKey.HANDS$STAGE_OPEN_PR,
  watch_ci: I18nKey.HANDS$STAGE_WATCH_CI,
  repair_ci: I18nKey.HANDS$STAGE_REPAIR_CI,
  ready: I18nKey.HANDS$STAGE_READY,
  merged: I18nKey.HANDS$STAGE_MERGED,
};

const STATUS_LABEL: Record<StageStatus, I18nKey> = {
  done: I18nKey.HANDS$STATUS_DONE,
  current: I18nKey.HANDS$STATUS_CURRENT,
  waiting: I18nKey.HANDS$STATUS_WAITING,
  failed: I18nKey.HANDS$STATUS_FAILED,
  upcoming: I18nKey.HANDS$STATUS_UPCOMING,
  skipped: I18nKey.HANDS$STATUS_SKIPPED,
};

/** The stage a session is in while it runs normally. */
const STATE_STAGE: Partial<Record<HandsSessionState, StageId>> = {
  PLANNING: "plan",
  CODING: "code",
  REVIEWING: "review",
  OPENING_PR: "open_pr",
  WATCHING_CI: "watch_ci",
  REPAIRING_CI: "repair_ci",
  PUSHING_FIX: "repair_ci",
  READY_FOR_HUMAN_REVIEW: "ready",
  COMPLETED: "merged",
};

/** Where an escalation stopped the session; other reasons fall back by PR. */
const ESCALATION_STAGE: Record<string, StageId> = {
  review_rounds_exhausted: "review",
  coder_made_no_changes: "code",
  branch_changed_unexpectedly: "code",
  ci_repair_budget_exhausted: "repair_ci",
  ci_fix_failed: "repair_ci",
};

// Five columns, with the CI repair loop hanging below Watch CI.
const POSITION: Record<StageId, { col: number; row: number }> = {
  plan: { col: 0, row: 0 },
  approve_plan: { col: 1, row: 0 },
  code: { col: 2, row: 0 },
  review: { col: 3, row: 0 },
  approve_pr: { col: 4, row: 0 },
  open_pr: { col: 4, row: 1 },
  watch_ci: { col: 3, row: 1 },
  ready: { col: 2, row: 1 },
  merged: { col: 1, row: 1 },
  repair_ci: { col: 3, row: 2 },
};

const COLUMN_WIDTH = 150;
const ROW_HEIGHT = 92;
const NODE_WIDTH = 128;

const EDGES: ReadonlyArray<[StageId, StageId, string, string]> = [
  ["plan", "approve_plan", "s-r", "t-l"],
  ["approve_plan", "code", "s-r", "t-l"],
  ["code", "review", "s-r", "t-l"],
  ["review", "approve_pr", "s-r", "t-l"],
  ["approve_pr", "open_pr", "s-b", "t-t"],
  ["open_pr", "watch_ci", "s-l", "t-r"],
  ["watch_ci", "ready", "s-l", "t-r"],
  ["ready", "merged", "s-l", "t-r"],
  ["watch_ci", "repair_ci", "s-b", "t-t"],
  ["repair_ci", "watch_ci", "s-r", "t-b"],
];

interface StageNodeData extends Record<string, unknown> {
  stage: StageId;
  status: StageStatus;
  detail: string | null;
}

/** Work out the stage the session is at, and whether it stopped there. */
function activeStage(session: HandsSession): {
  stage: StageId | null;
  status: StageStatus;
} {
  switch (session.state) {
    case "AWAITING_APPROVAL":
      if (session.pendingApproval === "approve_plan") {
        return { stage: "approve_plan", status: "waiting" };
      }
      if (session.pendingApproval === "open_pr") {
        return { stage: "approve_pr", status: "waiting" };
      }
      return { stage: "repair_ci", status: "waiting" };
    case "SUSPENDED":
      return {
        stage: session.suspendedFrom
          ? (STATE_STAGE[session.suspendedFrom] ?? "plan")
          : "plan",
        status: "waiting",
      };
    case "ESCALATED":
      return {
        stage:
          ESCALATION_STAGE[session.escalation?.reason ?? ""] ??
          (session.pr ? "watch_ci" : "code"),
        status: "failed",
      };
    case "FAILED":
      return {
        stage: session.failure
          ? (STATE_STAGE[session.failure.stage] ?? "plan")
          : "plan",
        status: "failed",
      };
    case "CANCELLED":
    case "SUPERSEDED":
      return { stage: null, status: "failed" };
    default:
      return {
        stage: STATE_STAGE[session.state] ?? null,
        status: "current",
      };
  }
}

/** Status of one stage, given the stage the session has reached. */
function stageStatus(
  stage: StageId,
  reached: StageId | null,
  reachedStatus: StageStatus,
  session: HandsSession,
): StageStatus {
  const index = STAGE_ORDER.indexOf(stage);
  const reachedIndex = reached ? STAGE_ORDER.indexOf(reached) : -1;
  if (index > reachedIndex) return "upcoming";
  if (index === reachedIndex) return reachedStatus;
  if (
    stage === "approve_plan" &&
    session.settings?.gates?.approve_plan === false
  ) {
    return "skipped";
  }
  if (stage === "approve_pr" && session.settings?.gates?.open_pr === false) {
    return "skipped";
  }
  if (stage === "repair_ci" && !session.counters?.ciRepairRounds) {
    return "skipped";
  }
  return "done";
}

function StageNode({ data }: NodeProps<Node<StageNodeData>>) {
  const { t } = useTranslation("openhands");
  const { stage, status, detail } = data;
  return (
    <div
      data-testid={`hands-graph-node-${stage}`}
      data-status={status}
      className={cn(
        "flex h-full w-32 flex-col justify-center rounded-lg border px-2 py-1 text-left",
        status === "done" && "border-border bg-surface-raised text-content",
        status === "current" &&
          "border-2 border-contrast bg-surface-raised text-content",
        status === "waiting" &&
          "border-2 border-dashed border-contrast text-content",
        status === "failed" &&
          "border-2 border-danger bg-status-fail-bg text-status-fail-text",
        (status === "upcoming" || status === "skipped") &&
          "border-dashed border-border text-muted",
      )}
    >
      <Handle
        id="t-l"
        type="target"
        position={Position.Left}
        className="!opacity-0"
      />
      <Handle
        id="t-r"
        type="target"
        position={Position.Right}
        className="!opacity-0"
      />
      <Handle
        id="t-t"
        type="target"
        position={Position.Top}
        className="!opacity-0"
      />
      <Handle
        id="t-b"
        type="target"
        position={Position.Bottom}
        className="!opacity-0"
      />
      <Handle
        id="s-r"
        type="source"
        position={Position.Right}
        className="!opacity-0"
      />
      <Handle
        id="s-l"
        type="source"
        position={Position.Left}
        className="!opacity-0"
      />
      <Handle
        id="s-b"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
      />
      <span className="block truncate text-xs font-medium">
        {t(STAGE_LABEL[stage])}
      </span>
      <span className="block truncate text-2xs text-muted">
        {t(STATUS_LABEL[status])}
        {detail ? ` · ${detail}` : ""}
      </span>
    </div>
  );
}

const nodeTypes = { stage: StageNode };

/** Tailwind's md breakpoint: from here the graph is readable. */
const WIDE_QUERY = "(min-width: 768px)";

/** True when the media query matches; true where matchMedia is missing. */
function useMinWidth(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () =>
      typeof window.matchMedia !== "function" ||
      window.matchMedia(query).matches,
    () => true,
  );
}

/**
 * The run as a read-only graph: each stage shows done, current, waiting,
 * failed, upcoming or skipped, and the wrapper names the current stage for
 * screen readers.
 */
export function HandsExecutionGraph({ session }: { session: HandsSession }) {
  const { t } = useTranslation("openhands");
  const wide = useMinWidth(WIDE_QUERY);

  const { nodes, edges, currentLabel } = useMemo(() => {
    const isDone = session.state === "COMPLETED";
    const active = isDone
      ? { stage: "merged" as StageId, status: "done" as StageStatus }
      : activeStage(session);

    const builtNodes: Node<StageNodeData>[] = STAGE_ORDER.map((stage) => {
      const status = stageStatus(stage, active.stage, active.status, session);
      let detail: string | null = null;
      if (stage === "review" && session.counters?.reviewRounds) {
        detail = t(I18nKey.HANDS$STAGE_REVIEW_ROUND, {
          count: session.counters.reviewRounds,
        });
      }
      if (
        stage === "repair_ci" &&
        session.settings?.ciRepairBudget !== undefined
      ) {
        detail = t(I18nKey.HANDS$STAGE_CI_REPAIR, {
          used: session.counters?.ciRepairRounds ?? 0,
          budget: session.settings.ciRepairBudget,
        });
      }
      const { col, row } = POSITION[stage];
      return {
        id: stage,
        type: "stage",
        position: { x: col * COLUMN_WIDTH, y: row * ROW_HEIGHT },
        data: { stage, status, detail },
        draggable: false,
        selectable: false,
        focusable: false,
        style: { width: NODE_WIDTH, height: 56 },
      };
    });

    const builtEdges: Edge[] = EDGES.map(
      ([from, to, sourceHandle, targetHandle]) => ({
        id: `${from}-${to}`,
        source: from,
        target: to,
        sourceHandle,
        targetHandle,
        type: "smoothstep",
        selectable: false,
        focusable: false,
      }),
    );

    const currentStageLabel = active.stage
      ? t(STAGE_LABEL[active.stage])
      : t(I18nKey.HANDS$STATUS_FAILED);
    return {
      nodes: builtNodes,
      edges: builtEdges,
      currentLabel: currentStageLabel,
    };
  }, [session, t]);

  // On a phone the graph's text is too small to read; list the stages.
  if (!wide) {
    return (
      <ol
        aria-label={t(I18nKey.HANDS$GRAPH_ARIA, { stage: currentLabel })}
        data-testid="hands-stage-list"
        className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm"
      >
        {nodes.map(({ data: { stage, status, detail } }) => (
          <li
            key={stage}
            data-testid={`hands-stage-${stage}`}
            data-status={status}
            aria-current={status === "current" ? "step" : undefined}
            className={cn(
              "flex flex-wrap items-baseline justify-between gap-x-2 rounded-md px-2 py-1",
              status === "current" && "bg-surface-raised font-medium",
              status === "failed" && "bg-status-fail-bg text-status-fail-text",
              (status === "upcoming" || status === "skipped") && "text-muted",
            )}
          >
            <span>{t(STAGE_LABEL[stage])}</span>
            <span className="text-xs text-muted">
              {t(STATUS_LABEL[status])}
              {detail ? ` · ${detail}` : ""}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div
      role="img"
      aria-label={t(I18nKey.HANDS$GRAPH_ARIA, { stage: currentLabel })}
      data-testid="hands-execution-graph"
      className="h-80 w-full overflow-hidden rounded-xl border border-border"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.3}
        maxZoom={1.25}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

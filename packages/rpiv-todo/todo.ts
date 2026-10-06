/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the package-root import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAutoClear, loadConfig, validateGuidanceFields } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { CLEAR_ENTRY_TYPE } from "./state/replay.js";
import {
	selectAutoClearEligible,
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "./state/selectors.js";
import type { TaskState } from "./state/state.js";
import { applyTaskMutation, clearTasksPreservingIds, type Op } from "./state/state-reducer.js";
import { commitState, getRenderState, getState, sid } from "./state/store.js";
import { applyAutoClear, buildToolResult } from "./tool/response-envelope.js";
import {
	ARG_CLEAR,
	CLEARED_MESSAGE_TYPE,
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskAction,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// English fallbacks for the `/todos clear` path. `{count}` is substituted at
// notify time, the same convention `overlay.expandHint` uses for `{key}`.
const MSG_USAGE = "Usage: /todos [clear]";
const MSG_NOTHING_TO_CLEAR = "No todos to clear.";
const MSG_CLEARED = "{count} cleared.";
const CLEAR_ARGUMENT_DESCRIPTION = "Remove every todo on this branch";

// English fallback for the auto-clear toast. `{count}` is substituted at notify
// time. The count names every removed row, tombstones included.
const MSG_AUTO_CLEARED = "Auto-cleared {count} todos.";

/**
 * Actions that may fire the auto-clear. `list` and `get` are excluded on
 * purpose: a read-only call must not mutate the list. `clear` is excluded
 * because it already empties the list.
 */
const AUTO_CLEAR_ACTIONS: ReadonlySet<TaskAction> = new Set(["create", "update", "delete"]);

/**
 * Model-facing bullet appended to the guideline list while `autoClear` is on.
 * Without it the model keeps calling `clear` by habit and keeps referencing ids
 * from a list it can no longer see.
 */
export const AUTO_CLEAR_GUIDELINE =
	"The list clears itself when every task is completed. Do not call `clear` for that, and do not reference ids from a cleared list.";

/**
 * Model-facing notice written beside a clear. This is LLM copy, not UI chrome,
 * so it stays an English literal like the tool description. It exists because
 * the durable clear entry never enters context: without this line the model
 * keeps believing the removed tasks exist.
 */
export function clearedModelNotice(count: number): string {
	const noun = count === 1 ? "task" : "tasks";
	return `Todo list cleared by the user. ${count} ${noun} removed. Task ids restart at 1.`;
}

/**
 * Autocomplete items for the `/todos ` argument. Returns the single `clear`
 * item for an empty or partial prefix, and `null` once the typed text can no
 * longer become `clear`, so Pi shows no popup for a bad argument.
 */
export function getTodosArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = (argumentPrefix ?? "").trim().toLowerCase();
	if (prefix !== "" && !ARG_CLEAR.startsWith(prefix)) return null;
	return [
		{ value: ARG_CLEAR, label: ARG_CLEAR, description: t("command.argument.clear", CLEAR_ARGUMENT_DESCRIPTION) },
	];
}

// ---------------------------------------------------------------------------
// Public re-exports — existing consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export function registerTodoTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	const baseGuidelines = guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES;
	// Appended after an override so a user-supplied `guidance.promptGuidelines`
	// still carries the auto-clear contract. `autoClear` is read here, at
	// registration, so flipping the config needs `/reload` to change the prompt.
	const promptGuidelines = getAutoClear() ? [...baseGuidelines, AUTO_CLEAR_GUIDELINE] : baseGuidelines;
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = sid(ctx);
			const result = applyTaskMutation(getState(sessionId), params.action, params as TaskMutationParams);
			commitState(sessionId, result.state);
			// Built from the pre-clear snapshot so the base line still describes the
			// call the model made; `applyAutoClear` then re-points `details`.
			const toolResult = buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
			const cleared = maybeAutoClear(sessionId, params.action, result.op);
			if (!cleared) return toolResult;
			if (ctx.hasUI) {
				ctx.ui.notify(
					t("command.auto_cleared", MSG_AUTO_CLEARED).replace("{count}", String(cleared.count)),
					"info",
				);
			}
			return applyAutoClear(toolResult, cleared.state, cleared.count);
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getRenderState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

// ---------------------------------------------------------------------------
// Auto-clear
// ---------------------------------------------------------------------------

export interface AutoClearResult {
	/** The committed empty snapshot — its `nextId` is unchanged. */
	state: TaskState;
	/** Rows removed, tombstones included. */
	count: number;
}

/**
 * Clear the list when a mutating action left every visible task completed.
 * Runs after the action's own commit, so it reads the post-mutation slot.
 *
 * Order matters: the caller builds the tool result from the pre-clear snapshot,
 * this commits the empty one, and `applyAutoClear` re-points `details` at it.
 * That committed snapshot is also what `state/replay.ts` reads back after
 * `/reload`, so the auto-clear needs no `rpiv-todo-clear` entry.
 *
 * Reads `autoClear` fresh on every call, so a config edit takes effect on the
 * next tool call. Returns `undefined` when the action cannot clear, the action
 * failed, the config disables the feature, or the list still holds work.
 */
export function maybeAutoClear(sessionId: string, action: TaskAction, op: Op): AutoClearResult | undefined {
	if (!AUTO_CLEAR_ACTIONS.has(action)) return undefined;
	if (op.kind === "error") return undefined;
	if (!getAutoClear()) return undefined;
	const state = getState(sessionId);
	if (!selectAutoClearEligible(state)) return undefined;
	const cleared = clearTasksPreservingIds(state);
	commitState(sessionId, cleared);
	return { state: cleared, count: state.tasks.length };
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

/**
 * @param refreshOverlay repaints the overlay after the clear. `index.ts` passes
 * its own `updateTodoOverlay(true)` closure — the command cannot reach the
 * widget directly, and no `tool_execution_end` fires for a slash command, so
 * without this the panel would keep the removed rows until the next tool call.
 */
export function registerTodosCommand(pi: ExtensionAPI, refreshOverlay: () => Promise<void> | void): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status, or clear them",
		getArgumentCompletions: getTodosArgumentCompletions,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg === ARG_CLEAR) {
				await clearTodos(pi, ctx, refreshOverlay);
				return;
			}
			if (arg !== "") {
				ctx.ui.notify(t("command.usage", MSG_USAGE), "error");
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * Clear path for `/todos clear`. Order matters:
 *  1. commit so live readers (overlay, `/todos`, `renderCall`) see an empty list;
 *  2. append the durable reset, because a replay of the branch would otherwise
 *     restore the tasks from the last `todo` tool result;
 *  3. tell the model, then repaint, then notify.
 */
async function clearTodos(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	refreshOverlay: () => Promise<void> | void,
): Promise<void> {
	const state = getState(sid(ctx));
	if (state.tasks.length === 0) {
		ctx.ui.notify(t("command.nothing_to_clear", MSG_NOTHING_TO_CLEAR), "info");
		return;
	}
	const { state: cleared, op } = applyTaskMutation(state, "clear", {});
	if (op.kind !== "clear") return;
	commitState(sid(ctx), cleared);
	pi.appendEntry(CLEAR_ENTRY_TYPE, { count: op.count });
	pi.sendMessage(
		{
			customType: CLEARED_MESSAGE_TYPE,
			content: clearedModelNotice(op.count),
			display: true,
			details: { count: op.count },
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify(t("command.cleared", MSG_CLEARED).replace("{count}", String(op.count)), "info");
	await refreshOverlay();
}

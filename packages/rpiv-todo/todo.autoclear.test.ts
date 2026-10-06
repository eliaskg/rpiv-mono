/**
 * Auto-clear — the `todo` tool empties the list when a mutating action leaves
 * every visible task completed. Covers the predicate, the id contract, the
 * model-facing envelope, the toast, and the `autoClear` config switch.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { __resetState, getNextId, getTodos, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { TaskAction, TaskDetails } from "./tool/types.js";

/** Default session id `createMockCtx` mints — the task-state slot key. */
const SESSION_ID = "test-session";
const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function removeConfig(): void {
	rmSync(CONFIG_PATH, { force: true });
}

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { pi, captured, tool };
}

type ToolCall = Record<string, unknown>;

/** The envelope shape the `todo` tool returns — narrowed for assertions. */
interface Envelope {
	content: Array<{ type: "text"; text: string }>;
	details: TaskDetails;
}

/** Run one tool call against the default session slot and return its envelope. */
async function call(tool: ReturnType<typeof setup>["tool"], params: ToolCall, hasUI = false) {
	const ctx = createMockCtx({ hasUI });
	const result = (await tool.execute?.(
		"tc",
		params as never,
		undefined as never,
		undefined as never,
		ctx as never,
	)) as unknown as Envelope;
	return { result, ctx };
}

/** Run a scripted sequence of calls; the last one's envelope is returned. */
async function seed(tool: ReturnType<typeof setup>["tool"], actions: ToolCall[], hasUI = false) {
	const [first, ...rest] = actions;
	let step = await call(tool, first as ToolCall, hasUI);
	for (const action of rest) step = await call(tool, action, hasUI);
	return step;
}

beforeEach(() => {
	__resetState();
	removeConfig();
});
afterEach(() => {
	__resetState();
	removeConfig();
});

describe("auto-clear — clears a fully completed list", () => {
	it("empties the list when the last visible task completes", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 2, status: "completed" },
		]);
		expect(getTodos(SESSION_ID)).toEqual([]);
	});

	it("clears a single completed task", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "only" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(getTodos(SESSION_ID)).toEqual([]);
		expect(getNextId(SESSION_ID)).toBe(2);
	});

	it("clears when a delete leaves only completed tasks, and counts tombstones", async () => {
		const { tool } = setup();
		const { result } = await seed(tool, [
			{ action: "create", subject: "done" },
			{ action: "create", subject: "dropped" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "delete", id: 2 },
		]);
		expect(getTodos(SESSION_ID)).toEqual([]);
		expect(result?.content[0].text).toBe("Deleted #2: dropped\nAuto-cleared 2 tasks. Task ids continue at 3.");
	});

	it("heals an all-completed list restored by /tree on the next no-op update", async () => {
		// Seed with the feature off, so the all-completed state survives.
		writeConfig({ autoClear: false });
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(getTodos(SESSION_ID)).toHaveLength(1);

		writeConfig({ autoClear: true });
		await call(tool, { action: "update", id: 1, status: "completed" });
		expect(getTodos(SESSION_ID)).toEqual([]);
	});
});

describe("auto-clear — leaves work alone", () => {
	it("does not clear while a pending task remains", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "done" },
			{ action: "create", subject: "later" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(getTodos(SESSION_ID).map((task) => task.status)).toEqual(["completed", "pending"]);
	});

	it("does not clear while an in_progress task remains", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "done" },
			{ action: "create", subject: "active", activeForm: "Working" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 2, status: "in_progress" },
		]);
		expect(getTodos(SESSION_ID)).toHaveLength(2);
	});

	it("never clears a tombstone-only list", async () => {
		writeConfig({ autoClear: false });
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "delete", id: 1 },
		]);
		writeConfig({ autoClear: true });
		await call(tool, { action: "delete", id: 2 });
		expect(getTodos(SESSION_ID).map((task) => task.status)).toEqual(["deleted", "deleted"]);
	});

	it("does not clear on read-only actions", async () => {
		writeConfig({ autoClear: false });
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		for (const action of ["list", "get"] satisfies TaskAction[]) {
			await call(tool, action === "list" ? { action } : { action, id: 1 });
		}
		expect(getTodos(SESSION_ID)).toHaveLength(1);
	});

	it("does not clear when the action itself failed", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		// The list is already empty — the failed call must not notify again.
		const { result, ctx } = await call(tool, { action: "update", id: 99, status: "completed" }, true);
		expect(result?.content[0].text).toBe("Error: #99 not found");
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("auto-clear — id contract", () => {
	it("keeps the counter, so a stale id misses instead of hitting a new task", async () => {
		const { tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 2, status: "completed" },
		]);
		expect(getNextId(SESSION_ID)).toBe(3);

		const stale = await call(tool, { action: "update", id: 2, status: "completed" });
		expect(stale.result?.content[0].text).toBe("Error: #2 not found");

		await call(tool, { action: "create", subject: "next" });
		expect(getTodos(SESSION_ID).map((task) => task.id)).toEqual([3]);
	});
});

describe("auto-clear — model envelope", () => {
	it("reports the clear below the base line and empties the replay snapshot", async () => {
		const { tool } = setup();
		const { result } = await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 2, status: "in_progress" },
			{ action: "update", id: 2, status: "completed" },
		]);
		expect(result?.content[0].text).toBe(
			"Updated #2 (in_progress → completed)\nAuto-cleared 2 tasks. Task ids continue at 3.",
		);
		expect(result?.details.tasks).toEqual([]);
		expect(result?.details.nextId).toBe(3);
		expect(result?.details.action).toBe("update");
	});

	it("writes no session entry and sends no message — the details snapshot is the reset", async () => {
		const { pi, captured, tool } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(captured.entries).toEqual([]);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("auto-clear — toast", () => {
	it("notifies once with the removed count", async () => {
		const { tool } = setup();
		const { ctx } = await seed(
			tool,
			[
				{ action: "create", subject: "a" },
				{ action: "create", subject: "b" },
				{ action: "update", id: 1, status: "completed" },
				{ action: "update", id: 2, status: "completed" },
			],
			true,
		);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith("Auto-cleared 2 todos.", "info");
	});

	it("clears without notifying in a headless session", async () => {
		const { tool } = setup();
		const { ctx } = await seed(
			tool,
			[
				{ action: "create", subject: "a" },
				{ action: "update", id: 1, status: "completed" },
			],
			false,
		);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).not.toHaveBeenCalled();
		expect(getTodos(SESSION_ID)).toEqual([]);
	});
});

describe("auto-clear — session scoping", () => {
	it("clears only the calling session's slot", async () => {
		const { tool } = setup();
		const parent = createMockCtx({ sessionId: "parent" });
		const child = createMockCtx({ sessionId: "child" });
		const run = (ctx: ReturnType<typeof createMockCtx>, params: ToolCall) =>
			tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);

		await run(parent, { action: "create", subject: "parent-task" });
		await run(child, { action: "create", subject: "child-task" });
		await run(child, { action: "update", id: 1, status: "completed" });

		expect(getTodos("child")).toEqual([]);
		expect(getNextId("child")).toBe(2);
		expect(getTodos("parent").map((task) => task.subject)).toEqual(["parent-task"]);
	});
});

describe("auto-clear — config switch", () => {
	it("leaves the completed list in place when autoClear is false", async () => {
		writeConfig({ autoClear: false });
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const { result, ctx } = await call(tool, { action: "update", id: 1, status: "completed" }, true);
		expect(getTodos(SESSION_ID).map((task) => task.status)).toEqual(["completed"]);
		expect(result?.content[0].text).toBe("Updated #1 (pending → completed)");
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).not.toHaveBeenCalled();
	});

	it("takes effect on the next call without a reload", async () => {
		const { tool } = setup();
		writeConfig({ autoClear: false });
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(getTodos(SESSION_ID)).toHaveLength(1);

		writeConfig({ autoClear: true });
		await call(tool, { action: "create", subject: "b" });
		await call(tool, { action: "update", id: 2, status: "completed" });
		expect(getTodos(SESSION_ID)).toEqual([]);
	});
});

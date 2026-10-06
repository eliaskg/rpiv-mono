import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, getTodos, registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";

/** Default session id `createMockCtx` mints — the task-state slot key. */
const SESSION_ID = "test-session";
const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

/**
 * `autoClear` is on by default, so a fully completed list empties itself before
 * `/todos` can print it. Grouped-output tests that need completed rows to
 * survive write `{ autoClear: false }` first.
 */
function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	const refreshOverlay = vi.fn(async () => {});
	registerTodoTool(pi);
	registerTodosCommand(pi, refreshOverlay);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	const cmd = captured.commands.get("todos");
	if (!cmd) throw new Error("command not registered");
	return { pi, captured, tool, cmd, refreshOverlay };
}

async function seed(tool: ReturnType<typeof setup>["tool"], actions: Array<Record<string, unknown>>) {
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
}

beforeEach(() => {
	__resetState();
	removeConfigFile();
});
afterEach(() => {
	__resetState();
	removeConfigFile();
	vi.restoreAllMocks();
});

describe("/todos command — registration", () => {
	it("registers a command named 'todos' with a description", () => {
		const { cmd } = setup();
		expect(cmd.description).toContain("todos");
	});
});

describe("/todos command — guard branches", () => {
	it("notifies an error when the session has no UI", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("notifies an info message when there are no visible tasks", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No todos"), "info");
	});

	it("treats all-deleted tasks as empty (info notify, not group render)", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "deleted" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No todos"), "info");
	});
});

describe("/todos command — grouped output", () => {
	function grabOutput(ctx: ExtensionContext): string {
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0];
		expect(level).toBe("info");
		return text as string;
	}

	it("renders 'Pending' group with ○ glyph and task id", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "research" }]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── Pending ──");
		expect(out).toContain("○ #1 research");
		expect(out).toContain("1 pending");
	});

	it("renders 'In Progress' group with ◐ glyph and activeForm suffix", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "build", activeForm: "Building" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── In Progress ──");
		expect(out).toContain("◐ #1 build (Building)");
		expect(out).toContain("1 in progress");
	});

	it("renders 'Completed' group with ✓ glyph and 'N/M completed' header", async () => {
		writeConfigFile(JSON.stringify({ autoClear: false }));
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "ship" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── Completed ──");
		expect(out).toContain("✓ #1 ship");
		expect(out).toContain("1/1 completed");
	});

	it("emits the header parts in 'completed · in progress · pending' order", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "p" },
			{ action: "create", subject: "ip" },
			{ action: "update", id: 2, status: "in_progress" },
			{ action: "create", subject: "done" },
			{ action: "update", id: 3, status: "completed" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		const header = out.split("\n")[0];
		const iC = header.indexOf("completed");
		const iIP = header.indexOf("in progress");
		const iP = header.indexOf("pending");
		expect(iC).toBeGreaterThanOrEqual(0);
		expect(iIP).toBeGreaterThan(iC);
		expect(iP).toBeGreaterThan(iIP);
	});

	it("appends '⛓ #deps' suffix for tasks with blockedBy", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "base" },
			{ action: "create", subject: "follow-up", blockedBy: [1] },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("⛓ #1");
	});

	it("omits deleted tombstones from the grouped output", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "keep" },
			{ action: "create", subject: "drop" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("keep");
		expect(out).not.toContain("drop");
	});
});

describe("/todos command — clear", () => {
	it("empties the list, appends the durable reset entry, and repaints", async () => {
		const { captured, tool, cmd, refreshOverlay } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		expect(getTodos(SESSION_ID)).toHaveLength(2);

		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("clear", ctx as never);

		expect(getTodos(SESSION_ID)).toEqual([]);
		expect(captured.entries).toEqual([{ customType: "rpiv-todo-clear", data: { count: 2 } }]);
		expect(refreshOverlay).toHaveBeenCalledTimes(1);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith("2 cleared.", "info");
	});

	it("tells the model about the clear without triggering a turn", async () => {
		const { pi, tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "a" }]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("clear", ctx as never);
		const sendMessage = pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "rpiv-todo-cleared",
				display: true,
				content: "Todo list cleared by the user. 1 task removed. Task ids restart at 1.",
				details: { count: 1 },
			}),
			{ triggerTurn: false },
		);
	});

	it("notifies and writes nothing when the list is already empty", async () => {
		const { captured, pi, cmd, refreshOverlay } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("clear", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith("No todos to clear.", "info");
		expect(captured.entries).toEqual([]);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(refreshOverlay).not.toHaveBeenCalled();
	});

	it("clears tombstones and counts them", async () => {
		const { captured, tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "deleted" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("clear", ctx as never);
		expect(getTodos(SESSION_ID)).toEqual([]);
		expect(captured.entries).toEqual([{ customType: "rpiv-todo-clear", data: { count: 1 } }]);
	});

	it("accepts the argument with mixed case and surrounding space", async () => {
		const { captured, tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "a" }]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("  CLEAR ", ctx as never);
		expect(captured.entries).toHaveLength(1);
		expect(getTodos(SESSION_ID)).toEqual([]);
	});

	it("rejects an unknown argument and leaves the list untouched", async () => {
		const { captured, tool, cmd, refreshOverlay } = setup();
		await seed(tool, [{ action: "create", subject: "keep" }]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("clear now", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith("Usage: /todos [clear]", "error");
		expect(getTodos(SESSION_ID)).toHaveLength(1);
		expect(captured.entries).toEqual([]);
		expect(refreshOverlay).not.toHaveBeenCalled();
	});

	it("keeps the interactive guard ahead of the clear path", async () => {
		const { captured, tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "a" }]);
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("clear", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(captured.entries).toEqual([]);
		expect(getTodos(SESSION_ID)).toHaveLength(1);
	});

	it("restarts ids at 1 for tasks created after the clear", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "old" }]);
		await cmd.handler("clear", createMockCtx({ hasUI: true }) as never);
		await seed(tool, [{ action: "create", subject: "new" }]);
		expect(getTodos(SESSION_ID).map((task) => task.id)).toEqual([1]);
		expect(getTodos(SESSION_ID).map((task) => task.subject)).toEqual(["new"]);
	});
});

describe("/todos command — argument completion", () => {
	it("offers `clear` for an empty and a partial prefix", async () => {
		const { cmd } = setup();
		const complete = cmd.getArgumentCompletions;
		expect(await complete?.("")).toEqual([
			{ value: "clear", label: "clear", description: "Remove every todo on this branch" },
		]);
		const partial = await complete?.("cle");
		expect(partial?.[0]?.value).toBe("clear");
	});

	it("offers nothing once the prefix cannot become `clear`", () => {
		const { cmd } = setup();
		expect(cmd.getArgumentCompletions?.("x")).toBeNull();
	});
});

import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { formatOverlayTaskLine, renderTodoResult } from "./format.js";

const recordingTheme = makeTheme({
	fg: (color, text) => `<${color}>${text}</${color}>`,
	strikethrough: (text) => `<strike>${text}</strike>`,
}) as unknown as Theme;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

describe("formatOverlayTaskLine — semantic color hierarchy", () => {
	it("keeps pending subjects primary while rendering IDs quietly", () => {
		expect(formatOverlayTaskLine(task(), recordingTheme, true)).toBe(
			"<dim>○</dim> <dim>#1</dim> <text>quiet task</text>",
		);
	});

	it("emphasizes the current task while muting its supporting metadata", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", activeForm: "Working", blockedBy: [2, 3] }),
				recordingTheme,
				true,
			),
		).toBe(
			"<warning>◐</warning> <dim>#1</dim> <accent>quiet task</accent> <muted>(Working)</muted> <muted>⛓ #2,#3</muted>",
		);
	});

	it("mutes and strikes completed subjects", () => {
		expect(formatOverlayTaskLine(task({ status: "completed" }), recordingTheme, false)).toBe(
			"<success>✓</success> <strike><muted>quiet task</muted></strike>",
		);
	});
});

describe("formatOverlayTaskLine — terminal control characters", () => {
	it("strips escape sequences from subject and activeForm before theming", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", subject: "quiet\u001b[2Jtask", activeForm: "Work\u009bcing" }),
				recordingTheme,
				false,
			),
		).toBe("<warning>◐</warning> <accent>quiettask</accent> <muted>(Working)</muted>");
	});
});

describe("renderTodoResult — status echo", () => {
	function echo(details: unknown): string {
		return renderTodoResult({ details }, recordingTheme).render(80).join("").trim();
	}

	it("still echoes 'deleted' after an auto-clear removed the tombstone", () => {
		expect(echo({ action: "delete", params: { id: 2 }, tasks: [], nextId: 3 })).toBe("<muted>⊘ deleted</muted>");
	});

	it("falls back to a plain check when the delete failed", () => {
		expect(echo({ action: "delete", params: { id: 99 }, tasks: [], nextId: 1, error: "#99 not found" })).toBe(
			"<success>✓</success>",
		);
	});

	it("echoes the requested status for an update whose task is gone", () => {
		expect(echo({ action: "update", params: { id: 2, status: "completed" }, tasks: [], nextId: 3 })).toBe(
			"<success>● completed</success>",
		);
	});
});

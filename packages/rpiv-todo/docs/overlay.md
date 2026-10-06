# Overlay and `/todos` display

How
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | Only while at least one overlay-visible task exists. The widget unregisters itself when the list empties, and re-registers when a task reappears. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last `todo` tool result's snapshot, which replaces the whole list
(last-write-wins).

## Anatomy of a row

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Heading** — `● Todos (done/total)` in the accent color while any task is
  `pending` or `in_progress`; `○ Todos (done/total)` dimmed once everything is
  completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `✗` deleted.
  Completed and deleted subjects render dim and struck through.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Dependencies** — appended as `⛓ #1,#2` when the task has a `blockedBy` set.
- **`#id` prefix** — shown on every row only when at least one visible task
  carries a `blockedBy`. Without a `⛓ #N` anywhere, the per-row ids have nothing
  to point at, so they are omitted.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. When there are more tasks than fit:

1. one row is reserved for the summary line;
2. completed tasks are dropped first, newest first — the oldest completed rows
   are the last completed rows to go;
3. if the unfinished tasks alone still overflow, the tail of that list is
   truncated;
4. the last row becomes `+N more (X completed, Y pending)`.

Use Pi's tool-output expansion shortcut (`ctrl+o` by default) to expand the
widget and show every task. Collapsing Pi's tool output reapplies the configured
row budget. Unfinished work is therefore the last thing to disappear in the
compact view. See [configuration.md](./configuration.md#maxwidgetlines) for the
budget's floor and reload semantics.

## Completed tasks fading out

A completed task stays on screen for the remainder of the turn in which it was
completed. At the start of the next agent turn, every completed row that has
already been displayed is hidden from later renders. Reloading or compacting the
session resets that tracking, so a fresh session shows the full list again.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to two lines — the heading plus a dim
`└─ ctrl+shift+t to expand` hint — and again to expand it. The hint always shows
the currently configured key.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). If the shortcut is set to
`"off"` while the panel is collapsed, the hint becomes a static `collapsed`
label rather than advertising an unbindable key.

## `/todos`

`/todos` prints the whole list grouped by status, independent of the overlay's
row budget and auto-hiding:

```
2/7 completed · 1 in progress · 4 pending
── Pending ──
  ○ #4 Register DI bindings
  ○ #5 Add integration tests    ⛓ #4
  ○ #6 Wire up the HTTP endpoint
  ○ #7 Update the API docs
── In Progress ──
  ◐ #3 Create DemoTodoRepository (creating the repository)
── Completed ──
  ✓ #1 Create DemoTodo domain entity
  ✓ #2 Create IDemoTodoRepository interface
```

The header omits any count that is zero. Sections appear only when they have
tasks. Tombstoned tasks are never listed.

- With no tasks: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

### `/todos clear`

`/todos clear` removes every task on the current branch, tombstones included.
It asks for no confirmation. The argument is matched after trim and lowercase,
so `/todos Clear` works. Two words do not: `/todos clear now` reports
`Usage: /todos [clear]` and changes nothing.

The command runs the same `clear` reducer action the `todo` tool uses, in this
order:

1. Commit the empty list, so the panel and `/todos` see it at once.
2. Append a `rpiv-todo-clear` session entry. Replay reads it as a reset, so the
   clear survives `/reload`, `/compact`, and `/tree`. The entry carries the
   removed count only.
3. Write a `rpiv-todo-cleared` message with `triggerTurn: false`. The model
   reads it on its next turn, so the clear costs no round trip.
4. Repaint the panel and report `N cleared.`

Custom entries never enter model context. Step 3 is therefore what tells the
model the list is empty. Without it the model still sees the old `todo` tool
results and may call `update` on a removed id. That call returns
`#3 not found`.

State stays branch-relative. `/tree` navigation to a point before the clear
entry restores the tasks that were visible there.

- With no tasks: `No todos to clear.` Nothing is written.
- In a non-interactive session: `/todos requires interactive mode`

### Auto-clear

While `autoClear` is `true` (the default), the `todo` tool empties the list as
soon as a mutating action leaves every visible task `completed`. The check runs
after `create`, `update`, and `delete`. Reads never clear: `list` and `get` leave
the list alone. A list of only tombstones is already empty, so it does not
trigger a clear of its own.

The automatic clear differs from `/todos clear` in two ways:

1. It keeps the id counter. Tasks created afterwards continue at the next id, so
   a stale `update #3` returns `#3 not found` instead of hitting a new task.
   `/todos clear` restarts ids at `1`.
2. It writes no session entry and no message. The completing call's own tool
   result carries the empty snapshot, and replay reads that snapshot. The result
   text gains one line:

   ```text
   Updated #2 (in_progress → completed)
   Auto-cleared 2 tasks. Task ids continue at 3.
   ```

The panel disappears with the list, and you get one `Auto-cleared N todos.`
toast. Set `"autoClear": false` to keep a completed list on screen until you
clear it by hand. See the
[configuration reference](./configuration.md#autoclear).

## Localization

The overlay heading, the `+N more` summary, the collapse hint, the `/todos`
section headers, and the status words all localize through
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
when that package is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`,
`pt-BR`, `ru`, `uk`, `zh`.

LLM-facing output — the tool response envelope, reducer error messages, and the
schema descriptions — stays English by design.

The SDK is a soft optional peer, loaded through a dynamic import at module init.
When it is absent, every call site returns its inline English literal and the
extension stays online: no warning, no crash. Install it at any time with
`pi install npm:@juicesharp/rpiv-i18n` and restart the session. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.

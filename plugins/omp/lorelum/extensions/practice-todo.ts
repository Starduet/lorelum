import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";

const ENTRY = "lorelum.practice-todo";

interface Reminder {
  action?: "query" | "get";
  question: string;
  closed: boolean;
}

interface TodoDetails {
  op: string;
  phases: { tasks: { content: string }[] }[];
}

interface RunningLookup {
  id: string;
  reminder: Reminder;
  directory: string;
  output: string;
}

function removeCapture(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

// Use a literal operand without shell expansion or command chaining.
const lookupPrefix =
  /^(lore(?:\.cmd)?)[ \t]+(query|get)[ \t]+("([^"“”„‟\r\n\\`$%!]+)"|([a-zA-Z0-9_][\w.-]*))(?=[ \t]|$)/;
const reminderSuffix = /^[ \t]+--todo[ \t]+(P[1-9]\d*)$/;

export type PreparePracticeLookup = (event: ToolCallEvent) => ToolCallEventResult | undefined;

function completedLookup(text: string, reminder: Reminder): boolean {
  try {
    const result = JSON.parse(text);
    if (result?.ok !== true || result.command !== (reminder.action ?? "query")) return false;
    if (reminder.action === "get") {
      return (
        result.data?.practice?.id === reminder.question &&
        typeof result.data.practice.body === "string"
      );
    }
    return Array.isArray(result.data?.results) && result.data.results.length > 0;
  } catch {
    return false;
  }
}

export default function practiceTodo(api: ExtensionAPI): PreparePracticeLookup {
  let reminders: ReadonlyMap<string, Reminder> = new Map();
  const running = new Map<string, RunningLookup>();

  function clearRunning(): void {
    for (const lookup of running.values()) removeCapture(lookup.directory);
    running.clear();
  }

  function restore(_event: unknown, ctx: ExtensionContext): void {
    clearRunning();
    const entry = ctx.sessionManager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === ENTRY);
    reminders = new Map(entry?.data as [string, Reminder][] | undefined);
  }

  function save(next: Map<string, Reminder>): void {
    api.appendEntry(ENTRY, [...next]);
    reminders = next;
  }

  api.on("session_start", restore);
  api.on("session_switch", restore);
  api.on("session_branch", restore);
  api.on("session_tree", restore);
  api.on("turn_end", clearRunning);
  api.on("session_shutdown", clearRunning);

  api.registerTool({
    name: "close_lore_lookup",
    label: "Close Lorelum reminder",
    description: "Cancel one pending Lorelum reminder by its displayed ID at the user's request.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { id }: { id: string }) {
      const reminder = reminders.get(id);
      if (!reminder || reminder.closed) {
        return {
          content: [{ type: "text", text: `No pending Lorelum reminder with ID ${id}.` }],
          details: {},
        };
      }
      const next = new Map(reminders);
      next.set(id, { ...reminder, closed: true });
      save(next);
      return { content: [{ type: "text", text: `Closed Lorelum reminder ${id}.` }], details: {} };
    },
  });

  api.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const lookup = running.get(event.toolCallId);
    if (!lookup) return;
    running.delete(event.toolCallId);
    const { id, reminder, directory, output } = lookup;
    let text: string | undefined;
    try {
      text = readFileSync(output, "utf8");
    } catch {
      // A denied or interrupted call may not create the capture.
    } finally {
      removeCapture(directory);
    }
    if (reminders.get(id) !== reminder) return;

    let status = `Lorelum reminder ${id} remains pending.`;
    if (!event.isError && text && completedLookup(text, reminder)) {
      const next = new Map(reminders);
      next.set(id, { ...reminder, closed: true });
      try {
        save(next);
        status = `Lorelum reminder ${id} completed.`;
      } catch {
        status = `Lorelum reminder ${id} remains pending because its completion could not be saved.`;
      }
    }
    return {
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...event.content.filter((item) => item.type !== "text" || item.text.trim().length > 0),
        { type: "text", text: status },
      ],
    };
  });

  api.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    const details = event.details as TodoDetails | undefined;
    if (!details) return;
    const { op, phases } = details;
    if (op === "init" || op === "append") {
      // The append result contains the whole plan. Only submitted append items
      // identify the new tasks, whose contents are unique in the committed plan.
      const appended = op === "append" ? new Set<string>(event.input.items) : undefined;
      let next: Map<string, Reminder> | undefined;
      for (const { tasks } of phases) {
        for (const { content } of tasks) {
          if (appended && !appended.has(content)) continue;
          markers: for (const [, kind, value] of content.matchAll(
            /\[(query|get):\s*([^\]\r\n]+)\]/g,
          )) {
            const action = kind === "get" ? "get" : "query";
            const question = value.trim();
            if (!question) continue;
            for (const item of (next ?? reminders).values()) {
              if (
                (item.action ?? "query") === action &&
                item.question === question &&
                (op === "init" || !item.closed)
              )
                continue markers;
            }
            next ??= new Map(reminders);
            next.set(`P${next.size + 1}`, { action, question, closed: false });
          }
        }
      }
      if (next) save(next);
    } else if (op !== "start" && op !== "done") {
      return;
    }

    const pending: string[] = [];
    for (const [id, { action, question, closed }] of reminders) {
      if (!closed) pending.push(`${id}: [${action ?? "query"}: ${question}]`);
    }
    if (pending.length === 0) return;
    return {
      content: [
        ...event.content,
        { type: "text", text: `Pending Lorelum reminders:\n${pending.join("\n")}` },
      ],
    };
  });

  return (event) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const command = event.input.command.trim();
    const match = lookupPrefix.exec(command);
    if (!match) return;
    const suffix = command.slice(match[0].length);
    if (!/(?:^|[ \t])--todo(?:[ \t=]|$)/.test(suffix)) return;
    const id = reminderSuffix.exec(suffix)?.[1];
    if (!id) {
      return {
        block: true,
        reason: "Use one standalone lore query/get command with a literal target and --todo ID.",
      };
    }
    const [, executable, action, literal, quoted, bare] = match;
    const target = quoted ?? bare;
    const reminder = reminders.get(id);
    if (!reminder || reminder.closed) {
      return {
        block: true,
        reason: `Lorelum reminder ${id} is ${reminder ? "settled" : "unknown"} in this branch. No lookup ran.`,
      };
    }
    if (
      action !== (reminder.action ?? "query") ||
      target !== reminder.question ||
      target.startsWith("-")
    ) {
      return {
        block: true,
        reason: `Command does not match Lorelum reminder ${id}. No lookup ran.`,
      };
    }
    if (
      event.input.async === true ||
      event.input.pty === true ||
      event.input.name ||
      event.input.ready != null ||
      event.input.notify != null
    ) {
      return { block: true, reason: `Run Lorelum reminder ${id} as a foreground Bash call.` };
    }
    if ([...running.values()].some((lookup) => lookup.id === id)) {
      return { block: true, reason: `Lorelum reminder ${id} is already running. No lookup ran.` };
    }
    const directory = mkdtempSync(join(tmpdir(), "lore-lookup-"));
    const output = join(directory, "result.json");
    // Foreground omp Bash uses its POSIX shell, including on Windows.
    const path = process.platform === "win32" ? output.replaceAll("\\", "/") : output;
    const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
    running.set(event.toolCallId, { id, reminder, directory, output });
    return {
      input: {
        ...event.input,
        command: `${executable} ${action} ${literal} --json > ${quotedPath}`,
      },
    };
  };
}

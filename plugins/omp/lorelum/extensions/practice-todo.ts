import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const ENTRY = "lorelum.practice-todo";

interface Reminder {
  question: string;
  closed: boolean;
}

interface TodoDetails {
  op: string;
  phases: { tasks: { content: string }[] }[];
}

export default function practiceTodo(api: ExtensionAPI): void {
  let reminders: ReadonlyMap<string, Reminder> = new Map();

  function restore(_event: unknown, ctx: ExtensionContext): void {
    const entry = ctx.sessionManager.getBranch().findLast(
      (item) => item.type === "custom" && item.customType === ENTRY,
    );
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

  api.registerTool({
    name: "close_lore_lookup",
    label: "Close Lorelum reminder",
    description:
      "Close one pending Lorelum reminder by its displayed ID after applying the relevant Practice, or if the user cancels it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { id }: { id: string }) {
      const reminder = reminders.get(id);
      if (!reminder || reminder.closed) {
        return { content: [{ type: "text", text: `No pending Lorelum reminder with ID ${id}.` }], details: {} };
      }
      const next = new Map(reminders);
      next.set(id, { question: reminder.question, closed: true });
      save(next);
      return { content: [{ type: "text", text: `Closed Lorelum reminder ${id}.` }], details: {} };
    },
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
          markers: for (const [, value] of content.matchAll(/\[practice:\s*([^\]\r\n]+)\]/gi)) {
            const question = value.trim();
            if (!question) continue;
            for (const item of (next ?? reminders).values()) {
              if (item.question === question && (op === "init" || !item.closed)) continue markers;
            }
            next ??= new Map(reminders);
            next.set(`P${next.size + 1}`, { question, closed: false });
          }
        }
      }
      if (next) save(next);
    } else if (op !== "start" && op !== "done") {
      return;
    }

    const pending: string[] = [];
    for (const [id, { question, closed }] of reminders) {
      if (!closed) pending.push(`${id}: ${question}`);
    }
    if (pending.length === 0) return;
    return {
      content: [...event.content, { type: "text", text: `Pending Lorelum reminders:\n${pending.join("\n")}` }],
    };
  });
}

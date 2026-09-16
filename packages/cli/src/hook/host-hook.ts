import {
  createListService,
  defaultStorageRoot,
  type ListPackDetailsResult,
  type ListService,
  type StorageRoot,
} from "@lorelum/engine";

import type { OutputWriter } from "../output/protocol.js";
import { resolveInvocationStorageRoot } from "../store/storage-root.js";
import { renderPackCatalog } from "./pack-catalog.js";

/** Hosts with a versioned raw session Hook ABI (`lore hook <host>`). */
export type HostHookName = "codex" | "zcode";

export type HostHookEvent = "SessionStart";

export interface HostHookInput {
  readonly hook_event_name?: string;
}

export interface HostHookResponse {
  readonly hookSpecificOutput?: {
    readonly hookEventName: HostHookEvent;
    readonly additionalContext: string;
  };
  readonly continue?: boolean;
}

export interface TextInput {
  text(): Promise<string>;
}

export interface HostHookServices {
  readonly list: Pick<ListService, "listPackDetails">;
  readonly storageRoot: StorageRoot;
}

export interface RunHostHookOptions {
  readonly host: HostHookName;
  readonly stdin: TextInput;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly services?: HostHookServices;
  readonly storeRoot?: string;
}

export interface HostHookInvocation {
  readonly storeRoot?: string;
}

const defaultServices: HostHookServices = Object.freeze({
  list: createListService(),
  storageRoot: defaultStorageRoot(),
});

/**
 * Detect a raw host Hook ABI (`hook <host>`) and consume its only supported
 * global option.
 */
export function parseHostHookInvocation(
  arguments_: readonly string[],
  host: HostHookName,
): HostHookInvocation | undefined {
  const positionals: string[] = [];
  let storeRoot: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--store-root") {
      const value = arguments_[index + 1];
      if (storeRoot !== undefined || typeof value !== "string" || value.length === 0) {
        return undefined;
      }
      storeRoot = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--store-root=")) {
      const value = argument.slice("--store-root=".length);
      if (storeRoot !== undefined || value.length === 0) return undefined;
      storeRoot = value;
      continue;
    }
    positionals.push(argument);
  }

  return positionals.length === 2 && positionals[0] === "hook" && positionals[1] === host
    ? { ...(storeRoot === undefined ? {} : { storeRoot }) }
    : undefined;
}

/**
 * Execute the versioned raw host Hook ABI. It deliberately does not emit the
 * normal Lorelum CLI envelope: the host consumes this envelope directly, and
 * every failure degrades to `{"continue":true}` so the host session continues.
 */
export async function runHostHook(options: RunHostHookOptions): Promise<0> {
  try {
    const input = parseHostHookInput(await options.stdin.text(), options.host);
    const response = await createHostHookResponse(
      input,
      options.host,
      options.services ?? defaultServices,
      options.storeRoot,
    );
    options.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    options.stderr.write(`lore hook ${options.host} degraded: ${diagnosticMessage(error)}\n`);
    options.stdout.write('{"continue":true}\n');
  }
  return 0;
}

export async function createHostHookResponse(
  input: HostHookInput,
  host: HostHookName,
  services: HostHookServices = defaultServices,
  storeRoot?: string,
): Promise<HostHookResponse> {
  if (input.hook_event_name !== "SessionStart") {
    throw new Error(`Lorelum ${hostLabel(host)} Hook received an unsupported event.`);
  }
  const storageRoot = resolveInvocationStorageRoot(storeRoot, services.storageRoot);
  const details = await services.list.listPackDetails({ storageRoot });
  return buildHostHookResponse(input.hook_event_name, details);
}

export function buildHostHookResponse(
  eventName: HostHookEvent,
  details: ListPackDetailsResult,
): HostHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: renderPackCatalog(
        details.packs.map((pack) => ({
          name: pack.name,
          version: pack.version,
          packRoot: pack.packRoot,
          ...(pack.description === undefined ? {} : { description: pack.description }),
          appliesTo: pack.applies_to ?? [],
        })),
      ),
    },
  };
}

function parseHostHookInput(serialized: string, host: HostHookName): HostHookInput {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) {
    throw new Error(`Lorelum ${hostLabel(host)} Hook input must be a JSON object.`);
  }
  return parsed;
}

function hostLabel(host: HostHookName): "Codex" | "Zcode" {
  return host === "codex" ? "Codex" : "Zcode";
}

function diagnosticMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

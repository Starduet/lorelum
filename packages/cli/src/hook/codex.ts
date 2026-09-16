import type { ListPackDetailsResult } from "@lorelum/engine";

import type { OutputWriter } from "../output/protocol.js";
import {
  buildHostHookResponse,
  createHostHookResponse,
  parseHostHookInvocation,
  runHostHook,
  type HostHookEvent,
  type HostHookInput,
  type HostHookInvocation,
  type HostHookResponse,
  type HostHookServices,
  type TextInput,
} from "./host-hook.js";

export type CodexHookEvent = HostHookEvent;
export type CodexHookInput = HostHookInput;
export type CodexHookResponse = HostHookResponse;
export type CodexHookServices = HostHookServices;
export type CodexHookInvocation = HostHookInvocation;
export type { TextInput } from "./host-hook.js";

export interface RunCodexHookOptions {
  readonly stdin: TextInput;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly services?: CodexHookServices;
  readonly storeRoot?: string;
}

/** Detect the raw Codex Hook ABI and consume its only supported global option. */
export function parseCodexHookInvocation(
  arguments_: readonly string[],
): CodexHookInvocation | undefined {
  return parseHostHookInvocation(arguments_, "codex");
}

/**
 * Execute the versioned raw Codex Hook ABI. It deliberately does not emit the
 * normal Lorelum CLI envelope: Codex consumes this envelope directly.
 */
export async function runCodexHook(options: RunCodexHookOptions): Promise<0> {
  return runHostHook({ ...options, host: "codex" });
}

export async function createCodexHookResponse(
  input: CodexHookInput,
  services?: CodexHookServices,
  storeRoot?: string,
): Promise<CodexHookResponse> {
  return createHostHookResponse(input, "codex", services, storeRoot);
}

export function buildCodexHookResponse(
  eventName: CodexHookEvent,
  details: ListPackDetailsResult,
): CodexHookResponse {
  return buildHostHookResponse(eventName, details);
}

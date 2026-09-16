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

export type ZcodeHookEvent = HostHookEvent;
export type ZcodeHookInput = HostHookInput;
export type ZcodeHookResponse = HostHookResponse;
export type ZcodeHookServices = HostHookServices;
export type ZcodeHookInvocation = HostHookInvocation;
export type { TextInput } from "./host-hook.js";

export interface RunZcodeHookOptions {
  readonly stdin: TextInput;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly services?: ZcodeHookServices;
  readonly storeRoot?: string;
}

/** Detect the raw ZCode Hook ABI and consume its only supported global option. */
export function parseZcodeHookInvocation(
  arguments_: readonly string[],
): ZcodeHookInvocation | undefined {
  return parseHostHookInvocation(arguments_, "zcode");
}

/**
 * Execute the versioned raw ZCode Hook ABI. It deliberately does not emit the
 * normal Lorelum CLI envelope: ZCode consumes this envelope directly.
 */
export async function runZcodeHook(options: RunZcodeHookOptions): Promise<0> {
  return runHostHook({ ...options, host: "zcode" });
}

export async function createZcodeHookResponse(
  input: ZcodeHookInput,
  services?: ZcodeHookServices,
  storeRoot?: string,
): Promise<ZcodeHookResponse> {
  return createHostHookResponse(input, "zcode", services, storeRoot);
}

export function buildZcodeHookResponse(
  eventName: ZcodeHookEvent,
  details: ListPackDetailsResult,
): ZcodeHookResponse {
  return buildHostHookResponse(eventName, details);
}

/**
 * Computer use through the in-process Cua Driver native SDK and its own tools.
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ComputerUseProviderName } from "@deepseek-ai/dsh-computer-use/brand";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import { z } from "zod";
import type {
  CuaDriver as NativeDriver,
  DriverAuthorizationAction,
  DriverAuthorizationDecision,
  DriverAuthorizationRequest,
} from "@trycua/cua-driver";
import type {} from "@deepseek-ai/dsh-computer-use";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";

/** Cordis plugin identity for the native Cua Driver provider. */
export const name = "experimental-computer-use-cua-driver-native";

/** Services required before the native runtime can publish tools. */
export const inject = ["computerUse", "tools", "systemPrompt"];

/** The native provider uses the installed SDK's same-process defaults. */
export const Config = Schema.object({});

const ToolCatalog = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.unknown().optional(),
    }),
  ),
});

/** DeepSeek's function-name alphabet and maximum length are protocol constants. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const GUIDANCE = `Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.

Sessions expire after 1800s idle / 3600s max. On a session_ended refusal, call start_session and retry the same call once — this is a transport reset, not an input failure.`;

/** Drop the cosmetic cursor, multi-session, and recording families for a single-agent desktop. */
const DROP_TOOLS = new Set([
  "move_cursor",
  "set_agent_cursor_theme",
  "set_agent_cursor_motion",
  "set_agent_cursor_enabled",
  "get_agent_cursor_state",
  "end_session",
  "get_session",
  "get_session_state",
  "list_sessions",
  "escalate_session",
  "start_recording",
  "stop_recording",
  "get_recording_state",
  "install_ffmpeg",
  "replay_trajectory",
]);

/**
 * CUA catalog shaping — two independent knobs:
 * - DSH_CUA_DROP (default '1' on): drop the cosmetic cursor / recording families
 *   plus the low-value session lifecycle/diagnostic tools (start_session is kept) —
 *   15 tools total — for a single-agent desktop.
 * - DSH_CUA_CONDENSE_PROSE (default '1' on): shorten top-level descriptions +
 *   strip per-field schema prose (keep type/enum/required) + re-inject the
 *   load-bearing short notes below. Set DSH_CUA_CONDENSE_PROSE=0 to keep the
 *   full field descriptions.
 */
const DROP = (process.env.DSH_CUA_DROP ?? "1") !== "0";
const CONDENSE_PROSE = (process.env.DSH_CUA_CONDENSE_PROSE ?? "1") !== "0";

/** Keep short "how to operate" descriptions for the load-bearing fields the condense would otherwise strip. */
const CONDENSE_SHORT: Record<string, string> = {
  session:
    "Repeat a consistent label; omit → implicit. Browser targets/tabs/refs bind to it.",
  delivery_mode:
    "background = mandatory first attempt; foreground only after background_unavailable.",
  element_index:
    "Needs matching snapshot_id (stale fails closed); prefer element_token.",
  snapshot_id: "Required with element_index; stale fails closed.",
  element_token: "Opaque handle (carries index+window); stale once superseded.",
  ref: "p<snapshot>:<index>; invalidated by navigation / newer snapshots.",
  tab_id: "Opaque tab id (session-scoped).",
  target_id: "Opaque target id (session-scoped; not a CDP id).",
  input_route:
    "trusted (default) won't foreground a standalone browser; dom_event = synthetic DOM click.",
  window_id:
    "HWND scoping the element cache; from list_windows/target. Optional once element_token carries it.",
  pid: "Process ID from list_apps; required for window scope, omit for desktop scope.",
  x: "Window-local screenshot pixels (get_window_state PNG space); pair with y.",
  y: "Window-local screenshot pixels (get_window_state PNG space); pair with x.",
  from_zoom:
    "true right after a zoom — x/y then refer to the last zoom image; auto-mapped back to window coords.",
  scope:
    "window (default, needs pid/window_id) vs desktop (screen-absolute, no pid).",
};

/** Hand-written condensed descriptions for the load-bearing tools (browser + desktop core). Mechanism kept, prose shortened — replaces the old 400-char hard cut. */
const SUMMARIZED_DESCRIPTIONS: Record<string, string> = {
  browser_click:
    'Click a page element (by `ref`) or viewport coordinates in an exactly-bound tab. Refused for heuristic bindings. Default `trusted` route = hardware-like `Input.dispatchMouseEvent`, refuses where it cannot preserve standalone-browser background posture; `input_route="dom_event"` (synthetic `el.click()`, ref required) only when explicitly requested — proves dispatch, not control activation.',
  browser_type:
    'Type text into an exactly-bound tab via the Input domain. `mode="insert_text"` (default) = `Input.insertText`; `mode="keystrokes"` = per-character key events. Both insert at the caret (typing into a field with text appends); `replace=true` sets/clears the field. Pass a `ref` to an editable element from the latest snapshot. Dispatch is not acceptance: trusted/CDP input only guarantees the event was delivered, not that the field took it (controlled components / IME / some editors can drop it), so a `success` result is not proof the value landed — read back the field (re-`get_browser_state`) to confirm.',
  browser_navigate:
    "Navigate one tab of an exactly-bound browser target to a new URL (http/https/about only). Refused for heuristic bindings. Navigation invalidates all `p<snapshot>:<index>` refs for the tab. For local files, start a temp http server (e.g. `npx serve` or a 15-line node server) and navigate to `http://127.0.0.1:PORT/` — `file://` is not supported.",
  browser_pointer:
    "Perform hover / right-click / double-click / scroll / drag in an exactly-bound browser tab. Semantic refs must declare `pointer` for hover/right-click/double-click/drag; scroll accepts a `scroll` or `pointer` capability. `trusted` route uses CDP Input events, refuses if standalone background posture cannot be preserved; `dom_event` route requires a page ref. Never activates or brings a tab to the foreground.",
  browser_dialog:
    "Inspect or resolve a page-owned JavaScript alert/confirm/prompt/beforeunload dialog on one exactly-bound tab. Never handles browser permission UI, extension UI, native dialogs, or file pickers. Inspect returns an opaque `dialog_id`; accept/dismiss require that exact current id. Resolution defaults to background delivery; Linux callers must request foreground.",
  browser_download:
    "Trigger one download through an exact live browser `ref` and save it inside an explicitly approved directory. Requires MCP-host destructive-tool approval, refuses ambiguous or stale capabilities, never returns the source URL/filename/destination path.",
  browser_set_input_files:
    "Assign one or more explicit absolute local files to an exact live `<input type=file>` `ref` through CDP. Bypasses native file pickers, rejects symlinks and non-regular files, never returns local paths.",
  browser_prepare:
    "Prepare an owned DevTools endpoint for a browser. `pid` required for existing process/profile; optional only for `allow_launch=true` isolated profile. Existing endpoints detected without side effects. Isolated profile: `allow_launch=true` launches a new Chromium, returns the bound target. Existing-profile attachment: standard mode needs `--grant existing-profile` or an embedding authorization host; bounded mode needs a matching manifest. Prefer an isolated profile (`isolated_new`/`isolated_named`, `allow_launch=true`) unless the task specifically needs the user's live session/tab — attaching to the existing profile disturbs their real Chrome.",
  get_browser_state:
    "Read-only browser inspection. Mode 1 (bind): pass `pid` + `window_id` of a native browser window to classify it, correlate to a CDP target (exact-or-refuse), mint a session-scoped target id + tab ids. Existing-profile bind in standard mode requires `--grant existing-profile` (else `browser_consent_required`). Mode 2 (snapshot): pass `target_id` + `tab_id`. Prefer `snapshot_format=semantic_v2` by default — it joins accessibility/DOM/layout/viewport state and is the only format that accepts `query`/`scope_ref`/`continuation` (the right path for locating a specific element or filtering refs). `dom_refs_v1` is a light flat-ref fallback with no query filtering — use it only for the lightest snapshot; `query`/`scope_ref`/`continuation` on `dom_refs_v1` error with `require snapshot_format=semantic_v2`. Browser tools require an explicit `session` label: `browser_navigate` / `get_browser_state` (read mode).",
  page: "Legacy browser compatibility tool. Prefer `get_browser_state` and the typed `browser_*` tools for exact targeting, endpoint ownership, and consent. Read-only `get_text` / `query_dom` available by default. Mutating actions require the daemon operator to set `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1` before daemon startup (restart after changing it); without it, mutating calls reject with `unbounded_operation_requires_unrestricted`. Does not provide the typed browser surface's exact binding or existing-profile grant guarantees. On a self-launched isolated Chromium (`enabled_remote_debugging: false`), the legacy `page` path is unavailable — use the typed `browser_*` tools (CDP) instead.",
  click:
    'Left-click against a target pid. Prefer `element_index` over pixel coordinates — works on backgrounded/minimized/hidden/off-desktop windows, surfaces a stable handle that survives rebuilds, and tells you what you are clicking via the cached element role + label. Reach for `x, y` only when the target is a canvas/video/WebGL/custom-drawn surface that does not appear in the UIA tree. On Qt/GTK list-item selection the background UIA Invoke is a no-op — go straight to `delivery_mode:"foreground"`.',
  type_text:
    'Insert text into the target pid via character-by-character `PostMessage(WM_CHAR)` to the focused window. No focus steal. XAML/WinUI3/UWP hosts route through ValuePattern.SetValue (WM_CHAR does not reach them); CJK may not read back on the PostMessage path — escalate to `delivery_mode:"foreground"` if the value does not land.',
  scroll:
    'Scroll the focused region of the target pid. Windows transport: WM_VSCROLL/WM_HSCROLL posted to the window (same events the OS sends for scrollbar/trackpad scroll, so background windows respond too); `by:"page"`→SB_PAGEDOWN/UP×amount, `by:"line"`→SB_LINEDOWN/UP×amount. `element_index` is accepted for cross-platform parity but is a no-op on Windows (UIA SetFocus not wired up yet — same caveat as `press_key`).',
  get_window_state:
    "Walk a running app UIA tree and return BOTH a structured `elements` array (preferred) AND a Markdown rendering (back-compat). Every actionable element is tagged `[element_index N]` in the markdown and as `element_index` in the structured array — pass those indices to `click`, `type_text`, `scroll`, etc. Set `query` to a case-insensitive substring to project both `tree_markdown` and `elements` to matching rows + ancestor chain; `total_element_count` reports the complete snapshot, `returned_element_count` the projection.",
  zoom:
    'Zoom into a rectangular region of a window screenshot at full (native) resolution. Coordinates `x1, y1, x2, y2` are in the same pixel space as the screenshot returned by `get_window_state`. **The `required` array in the schema is incomplete: `pid` is mandatory for window scope (the runtime enforces it) but not listed in `required` — always pass `pid` alongside `window_id`.** Max zoom region width is 500 px in scaled-image coordinates.',
  launch_app:
    'Launch a Windows app hidden (SW_SHOWNOACTIVATE, no focus steal). Provide `bundle_id`/`name`/`aumid` or `path`. `urls` opens each URL in the default browser without activating it — **but the URL may not navigate (window opens on default page); verify with a fresh `get_window_state` after launch that the content actually loaded.** Returns pid + `windows` array (may be empty transiently — call `list_windows(pid)` a moment later).',
};

/** Strip per-field prose (description/title) from a JSON schema, keeping type/enum/required. */
function stripSchemaProse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaProse);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "description" || key === "title") continue;
      out[key] = stripSchemaProse(value);
    }
    return out;
  }
  return node;
}

/** Re-inject the short "how to operate" descriptions for CONDENSE_SHORT fields, at every `properties` level. */
function injectCondenseShort(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(injectCondenseShort);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      out[key] = injectCondenseShort(value);
    }
    const properties = out.properties;
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      for (const [field, def] of Object.entries(
        properties as Record<string, unknown>,
      )) {
        const short = CONDENSE_SHORT[field];
        if (short !== undefined && def && typeof def === "object") {
          (def as Record<string, unknown>).description = short;
        }
      }
    }
    return out;
  }
  return node;
}

/**
 * Own one native runtime and expose its catalog through the MCP result adapter.
 * Startup failures roll back every registration. Unload removes tools, aborts
 * calls and image admission, awaits settlement and SDK shutdown, then releases computer use.
 * @param ctx - context providing the exclusive registration and tool services.
 * @returns after native import, runtime creation, and tool discovery complete.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let driver: NativeDriver | undefined;
  // Cordis announces disposal before it awaits asynchronous plugin startup.
  ctx.on(
    "internal/plugin",
    (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort();
    },
    { global: true },
  );
  let ready: Promise<void> = Promise.resolve();
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(
      ComputerUseProviderName("cua-driver-native"),
    );
    yield async () => {
      lifetime.abort();
      // apply() reports startup failure; teardown still owns its native handle.
      await ready.catch(() => {});
      await Promise.allSettled(pending);
      if (driver !== undefined) {
        await driver.shutdown();
        driver.uniffiDestroy();
      }
    };
    const child = ctx.plugin({
      name: "computer-use-cua-driver-native-runtime",
      inject: ["tools", "systemPrompt"],
      apply: mountRuntime,
    });
    yield child.dispose;
    ready = Promise.resolve(child).then(() => {});
  }, "computer-use-cua-driver-native.runtime");
  try {
    await ready;
  } catch (error) {
    await dispose();
    throw error;
  }

  /** The child owns tool registrations; the outer effect owns native teardown. */
  async function mountRuntime(inner: Context): Promise<void> {
    const { CuaDriver, RuntimeAuthorizationOptions } =
      await import("@trycua/cua-driver");
    lifetime.signal.throwIfAborted();
    // The generated constructor returns its class with an owned binding handle,
    // but declares only CuaDriverLike, which omits uniffiDestroy().
    const authHost = {
      // existing-profile consent → Allow（回传同一 digest；DSH 是 trusted host，无条件放行）
      async authorize(
        request: DriverAuthorizationRequest,
      ): Promise<DriverAuthorizationDecision> {
        return {
          action: DriverAuthorizationAction.Allow,
          requestDigest: request.requestDigest,
        };
      },
    };
    const activeDriver = (driver =
      CuaDriver.createConfiguredWithAuthorizationHost(
        {
          claudeCodeCompatibility: false,
          authorization: RuntimeAuthorizationOptions.create({
            allowedModes: [0, 1, 2],
            compatibilityMode: 0,
            unrestrictedAcknowledged: true,
            maxSessionTtlSeconds: 3600n,
            maxIdleTtlSeconds: 1800n,
          }),
        },
        authHost,
      ) as NativeDriver);
    const catalog = ToolCatalog.parse(
      JSON.parse(await activeDriver.listToolsJson({ signal: lifetime.signal })),
    );
    lifetime.signal.throwIfAborted();
    const names = new Set<string>();
    for (const tool of catalog.tools) {
      if (DROP && DROP_TOOLS.has(tool.name)) continue;
      const publicName = `cua_driver_native__${tool.name}`;
      if (!TOOL_NAME.test(publicName)) {
        throw new Error(
          `Cua Driver tool "${tool.name}" exceeds the supported function-name format`,
        );
      }
      if (names.has(publicName))
        throw new Error(`Cua Driver listed tool "${tool.name}" more than once`);
      names.add(publicName);
      const definition = createMcpToolDefinition(inner, {
        name: publicName,
        rawName: tool.name,
        description: CONDENSE_PROSE
          ? (SUMMARIZED_DESCRIPTIONS[tool.name] ?? tool.description ?? "")
          : (tool.description ?? ""),
        inputSchema: CONDENSE_PROSE
          ? (injectCondenseShort(stripSchemaProse(tool.inputSchema)) as Record<
              string,
              unknown
            >)
          : tool.inputSchema,
        outputSchema: tool.outputSchema,
        async call(args, execution) {
          const combined = AbortSignal.any([execution.signal, lifetime.signal]);
          combined.throwIfAborted();
          const result = await activeDriver.callTool(
            tool.name,
            JSON.stringify(args),
            { signal: combined },
          );
          combined.throwIfAborted();
          const parsed = JSON.parse(result.rawJson) as {
            content?: Array<{ type?: string; text?: string }>;
            structuredContent?: unknown;
          };
          // The native driver keeps structured data (e.g. get_browser_state tabs[].tab_id) out of
          // its model-facing text, and the mcp-client render only projects `content`. Project
          // structuredContent into the last text block here so the model can actually see/use it
          // (bind reports "1 tab(s)" but not the tab_id that navigate/type require).
          const sc = parsed.structuredContent;
          if (sc !== undefined && sc !== null) {
            let structured = JSON.stringify(sc);
            if (structured.length > 4000)
              structured = `${structured.slice(0, 4000)} …(truncated)`;
            const suffix = `\n\n[structuredContent]\n${structured}`;
            const contentBlocks = Array.isArray(parsed.content)
              ? parsed.content
              : [];
            const textBlock = [...contentBlocks]
              .reverse()
              .find((b) => typeof b.text === "string");
            if (textBlock !== undefined) {
              textBlock.text = `${textBlock.text}${suffix}`;
            } else {
              parsed.content = [
                { type: "text", text: `[structuredContent]\n${structured}` },
                ...contentBlocks,
              ];
            }
          }
          return parsed as unknown;
        },
      });
      inner.tools.register(definition);
    }
    inner.on("tools/execute", async (exec, next) => {
      if (!names.has(exec.name)) return next();
      const upstream = exec.signal;
      exec.signal = AbortSignal.any([upstream, lifetime.signal]);
      const operation = Promise.resolve().then(next);
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
        exec.signal = upstream;
      }
    });
    inner.systemPrompt.section({
      name: "computer-use:cua-driver-native",
      order: inner.systemPrompt.getSectionOrder("TOOL_COMPUTER_USE"),
      text: GUIDANCE,
    });
  }
}

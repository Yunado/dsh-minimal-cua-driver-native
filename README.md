# dsh-minimal-cua-driver-native

Minimal CUA computer-use plugin for DeepSeek Harness (DSH). A thin wrapper around the Rust-backed `@trycua/cua-driver` SDK that exposes native computer-use (desktop + browser) as MCP tools, with condensed tool descriptions.

## What it does

Drives the `@trycua/cua-driver` native driver **in-process** (tsx-on-src, no separate daemon) and exposes its tools as an MCP provider. Covers:

- **Desktop** (native apps): `click`, `type_text`, `scroll`, `get_window_state`, `hotkey`, etc. (UIA-backed).
- **Browser**: `browser_prepare` / `get_browser_state` / `browser_navigate` / `browser_click` / `browser_type` (CDP/DevTools, exact-or-refuse binding, no-foreground posture).

## Key changes (vs the DSH `computer-use-cua-driver-native` experimental package)

- **Authorization host (existing-profile consent)** — embeds a `DriverAuthorizationHost` that auto-approves existing-profile binds, so `browser_prepare` / `get_browser_state` (bind) no longer fail with `browser_consent_required` / `consumer_profile_endpoint_requires_grant`.
- **Condensed tool descriptions** — mechanism kept, prose shortened (`DSH_CUA_CONDENSE`, default on); drops the cursor / multi-session / recording tool families (`DSH_CUA_DROP_TOOLS`, `DSH_CUA_DROP`).
- **Browser tool doc pitfalls** (in the `get_browser_state` / `browser_type` summaries):
  - Prefer `snapshot_format=semantic_v2` by default (only format that accepts `query` / `scope_ref` / `continuation`); `dom_refs_v1` is a light no-query fallback.
  - Browser tools require an **explicit `session`** label.
  - `browser_type` dispatch is not acceptance — read the value back (re-`get_browser_state`) to confirm it landed.
- **`structuredContent` → `text` fallback** in the `call` closure.

## Use

It's a standalone DSH (Cordis) plugin. Its only peer is the `computer-use` plugin (`@deepseek-ai/dsh-computer-use`); it has no dependency on any other plugin. Mount the CUA pair in a profile:

```yaml
# cordis.patch.yml
plugins:
  - computer-use
  - computer-use-cua-driver-native
```

Then `pnpm dsh web`. Edits to `src/index.ts` apply on **host restart** (tsx-on-src, no rebuild).

## Dependency

- `@trycua/cua-driver` (Rust/FFI CUA driver SDK + embedded Node host).

## Layout

- `src/index.ts` — the plugin (dynamic provider, wraps `@trycua/cua-driver`).
- `package.json` — package manifest (kept at the original DSH package name so it still drops back into a DSH checkout).
- `tests/` — spec / e2e tests.

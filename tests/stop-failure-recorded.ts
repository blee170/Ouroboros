import type { HookEvent } from '../src/shared/types'

/**
 * StopFailure hooks as Claude Code 2.1.332 sent them (recorded 2026-11-26: `claude -p` against a local API that
 * answered each request with one HTTP error). Every one carried the keys cwd, effort, error, hook_event_name,
 * last_assistant_message, prompt_id, session_id, transcript_path: a code in `error`, the words Claude Code showed in
 * `last_assistant_message`, and no `message`. The ids and paths are left out here; the two fields are as recorded.
 */
const recorded = (error: string, last_assistant_message: string): HookEvent => ({ hook_event_name: 'StopFailure', session_id: 'sess-recorded', error, last_assistant_message })

/** HTTP 429, rate_limit_error */
export const STOP_FAILURE_429 = recorded('rate_limit', "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.")
/** HTTP 529, overloaded_error: the code is server_error, not overloaded */
export const STOP_FAILURE_529 = recorded('server_error', 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:4708).')
/** HTTP 401, authentication_error */
export const STOP_FAILURE_401 = recorded('authentication_failed', 'Invalid API key · Fix external API key')

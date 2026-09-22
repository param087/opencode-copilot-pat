/**
 * copilot-pat — GitHub Copilot in OpenCode via a fine-grained Personal Access Token.
 *
 * Why this exists: OpenCode's built-in `github-copilot` provider sends its stored OAuth
 * token straight to api.githubcopilot.com, and that API refuses PATs unless the request
 * identifies as the Copilot CLI integration. This plugin registers a separate provider,
 * `copilot-pat`, which sends the PAT with `Copilot-Integration-Id: copilot-developer-cli`
 * (verified 2026-09-02: fine-grained PAT → 200, no token exchange needed).
 *
 * Token requirements: a *fine-grained* PAT (github_pat_…) owned by a personal account with
 * the "Copilot Requests" account permission. Classic PATs (ghp_…) are refused by GitHub on
 * every path ("Personal Access Tokens are not supported for this endpoint").
 * If you store an OAuth token (gho_/ghu_) instead, the plugin falls back to exchanging it at
 * copilot_internal/v2/token for a short-lived session token.
 *
 * Setup:   opencode auth login  →  Other  →  copilot-pat  →  paste the PAT
 *          (or edit ~/.local/share/opencode/auth.json:
 *           "copilot-pat": {"type":"api","key":"github_pat_…"})
 * Use:     opencode -m copilot-pat/claude-sonnet-5      (or set "model" in config)
 *
 * Env overrides (optional):
 *   COPILOT_PAT_API_URL         default https://api.githubcopilot.com
 *   COPILOT_PAT_TOKEN_URL       default https://api.github.com/copilot_internal/v2/token
 *   COPILOT_PAT_INTEGRATION_ID  default copilot-developer-cli (PAT mode) / vscode-chat (exchange mode)
 *   COPILOT_PAT_TRACE           path of a file to append hook/fetch trace lines to (debugging)
 */
import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER_ID = "copilot-pat"
const PROVIDER_NAME = "GitHub Copilot (PAT)"
const API_URL = (process.env.COPILOT_PAT_API_URL ?? "https://api.githubcopilot.com").replace(/\/$/, "")
const TOKEN_URL = process.env.COPILOT_PAT_TOKEN_URL ?? "https://api.github.com/copilot_internal/v2/token"
const USER_AGENT = "opencode-copilot-pat/1.0"
const MODELS_DEV_URL = "https://models.dev/api.json"
const REFRESH_MARGIN_SEC = 120

type Mode = "pat" | "exchange"
type Session = { token: string; expiresAt: number }
let session: Session | null = null
let inflight: Promise<Session> | null = null

const TRACE = process.env.COPILOT_PAT_TRACE
function trace(msg: string) {
  if (!TRACE) return
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

let clientLog: ((level: "info" | "warn" | "error", msg: string) => void) | null = null
function log(msg: string, level: "info" | "warn" | "error" = "info") {
  if (clientLog) return clientLog(level, msg)
  console.error(`[copilot-pat] ${msg}`)
}

const nowSec = () => Math.floor(Date.now() / 1000)
const isPat = (key: string) => key.startsWith("github_pat_") || key.startsWith("ghp_")
const modeFor = (key: string): Mode => (isPat(key) ? "pat" : "exchange")

function integrationId(mode: Mode) {
  return process.env.COPILOT_PAT_INTEGRATION_ID ?? (mode === "pat" ? "copilot-developer-cli" : "vscode-chat")
}

function explainExchange(status: number, body: string, key: string): string {
  const hints: string[] = []
  if (status === 404) hints.push("The exchange endpoint answers 404 for tokens without Copilot access. For PATs use a fine-grained token with the 'Copilot Requests' permission.")
  else if (status === 401) hints.push("Token is invalid, expired, or revoked.")
  return `token exchange failed: HTTP ${status} ${body.slice(0, 160).replace(/\s+/g, " ")}${hints.length ? " — " + hints.join(" ") : ""}`
}

/** Exchange-mode only: swap an OAuth token for a Copilot session token, cached until near expiry. */
async function getSessionToken(key: string): Promise<Session> {
  if (session && session.expiresAt - REFRESH_MARGIN_SEC > nowSec()) return session
  if (inflight) return inflight
  inflight = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${key}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Editor-Version": "vscode/1.109.2",
        "Editor-Plugin-Version": "copilot-chat/0.37.5",
        "X-GitHub-Api-Version": "2025-04-01",
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`[copilot-pat] ${explainExchange(res.status, text, key)}`)
    let data: { token?: string; expires_at?: number }
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`[copilot-pat] token exchange returned non-JSON: ${text.slice(0, 120)}`)
    }
    if (!data.token) throw new Error("[copilot-pat] token exchange response had no token field")
    const fromToken = /(?:^|;)exp=(\d+)/.exec(data.token)
    const expiresAt = fromToken ? Number(fromToken[1]) : (data.expires_at ?? nowSec() + 1500)
    session = { token: data.token, expiresAt }
    log(`session token acquired, expires in ${expiresAt - nowSec()}s`)
    return session
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** The bearer to put on Copilot API calls for this stored key. */
async function bearerFor(key: string): Promise<{ token: string; mode: Mode }> {
  const mode = modeFor(key)
  if (mode === "pat") return { token: key, mode }
  return { token: (await getSessionToken(key)).token, mode }
}

function copilotHeaders(token: string, mode: Mode, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "Copilot-Integration-Id": integrationId(mode),
    "Openai-Intent": "conversation-edits",
  }
  if (mode === "exchange") {
    base["Editor-Version"] = "vscode/1.109.2"
    base["Editor-Plugin-Version"] = "copilot-chat/0.37.5"
  }
  return { ...base, ...extra }
}

/** Turn an upstream PAT rejection into an actionable message. */
function explainUpstream(status: number, body: string, key: string): string | null {
  if (status === 400 && /Personal Access Tokens are not supported/i.test(body)) {
    if (key.startsWith("ghp_"))
      return "GitHub refuses classic PATs (ghp_) for Copilot. Create a fine-grained PAT (github_pat_) with the 'Copilot Requests' account permission at https://github.com/settings/personal-access-tokens/new"
    return "GitHub refused this token for Copilot. Check it is a fine-grained PAT owned by a personal account with the 'Copilot Requests' permission, and that the account has Copilot enabled."
  }
  return null
}

/** Model catalogue: OpenCode's cached models.dev copy, else models.dev, else a minimal fallback. */
type ModelsDevModel = Record<string, any>
async function loadCatalogue(): Promise<Record<string, ModelsDevModel>> {
  for (const file of [join(homedir(), ".cache", "opencode", "models.json")]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"))
      const models = parsed?.["github-copilot"]?.models
      if (models && Object.keys(models).length) return models
    } catch {}
  }
  try {
    const res = await fetch(MODELS_DEV_URL)
    if (res.ok) {
      const models = (await res.json())?.["github-copilot"]?.models
      if (models && Object.keys(models).length) return models
    }
  } catch (e) {
    log(`models.dev fetch failed: ${e}`, "warn")
  }
  const stub = (name: string, context = 128000, output = 16000) => ({
    name,
    attachment: false,
    reasoning: false,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context, output },
  })
  return {
    "gpt-4.1": stub("GPT-4.1"),
    "claude-sonnet-4.5": stub("Claude Sonnet 4.5", 200000, 64000),
    "claude-haiku-4.5": stub("Claude Haiku 4.5", 200000, 64000),
    "claude-sonnet-5": stub("Claude Sonnet 5", 200000, 64000),
    "claude-opus-5": stub("Claude Opus 5", 200000, 64000),
    "claude-opus-5.5": stub("Claude Opus 5.5", 200000, 64000),
  }
}

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 16000

/**
 * Build a catalogue entry from a Copilot `/models` item, for models the catalogue
 * has not caught up with yet (models.dev lags behind new Copilot releases).
 */
function fromApiModel(m: any): ModelsDevModel {
  const caps = m?.capabilities ?? {}
  const limits = caps.limits ?? {}
  const supports = caps.supports ?? {}
  const vision = supports.vision ?? !!limits.vision
  return {
    name: m.name ?? m.id,
    family: caps.family,
    attachment: vision,
    reasoning: !!(supports.thinking || supports.adaptive_thinking || supports.reasoning_effort),
    temperature: supports.temperature ?? true,
    tool_call: supports.tool_calls ?? true,
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    limit: {
      // max_context_window_tokens counts prompt + output; max_prompt_tokens is the
      // input budget, which is what OpenCode means by "context".
      context: limits.max_prompt_tokens ?? limits.max_context_window_tokens ?? DEFAULT_CONTEXT,
      output: limits.max_output_tokens ?? DEFAULT_OUTPUT,
    },
  }
}

/** Chat-capable models this account can use right now, keyed by id. */
function usableApiModels(body: any): { usable: Map<string, any>; disabled: string[] } {
  const usable = new Map<string, any>()
  const disabled: string[] = []
  for (const m of body?.data ?? []) {
    if (!m?.id) continue
    // Non-chat models (embeddings, completions) cannot back an OpenCode model.
    if (m.capabilities?.type && m.capabilities.type !== "chat") continue
    // Models whose policy is "disabled" need a one-time enable (VS Code model picker or
    // GitHub Copilot settings) before the API will serve them, so hide them.
    if (m.policy?.state === "disabled") {
      disabled.push(m.id)
      continue
    }
    usable.set(m.id, m)
  }
  return { usable, disabled }
}

type Discovery = { usable: Map<string, any>; disabled: string[]; mode: Mode }
const discoveries = new Map<string, Promise<Discovery | null>>()

/** GET /models, once per process per key. Returns null if the key is unusable or the call fails. */
function discover(key: string): Promise<Discovery | null> {
  let pending = discoveries.get(key)
  if (pending) return pending
  pending = (async () => {
    const { token, mode } = await bearerFor(key)
    const res = await fetch(`${API_URL}/models`, { headers: copilotHeaders(token, mode) })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(explainUpstream(res.status, body, key) ?? `HTTP ${res.status} ${body.slice(0, 120)}`)
    }
    const { usable, disabled } = usableApiModels(await res.json())
    return usable.size ? { usable, disabled, mode } : null
  })().catch((e) => {
    log(`model discovery skipped: ${e instanceof Error ? e.message : e}`, "warn")
    return null
  })
  discoveries.set(key, pending)
  return pending
}

/**
 * The stored PAT, read straight from auth.json. The `config` hook runs before
 * OpenCode hands the plugin any auth context, so there is no other way to reach it.
 */
async function storedKey(): Promise<string | null> {
  const dir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  try {
    const auth = JSON.parse(await readFile(join(dir, "opencode", "auth.json"), "utf8"))
    const entry = auth?.[PROVIDER_ID]
    return entry?.type === "api" && entry.key ? entry.key : null
  } catch {
    return null
  }
}

/**
 * Catalogue entries the account can use, plus any chat models the API offers that
 * the catalogue has not caught up with. Falls back to the plain catalogue.
 */
function reconcile(catalogue: Record<string, ModelsDevModel>, found: Discovery | null) {
  const models: Record<string, any> = {}
  if (!found) {
    for (const [id, m] of Object.entries(catalogue)) models[id] = toConfigModel(m)
    return { models, added: [] as string[], disabled: [] as string[] }
  }
  for (const [id, m] of Object.entries(catalogue)) if (found.usable.has(id)) models[id] = toConfigModel(m)
  const added: string[] = []
  for (const [id, m] of found.usable) {
    if (models[id]) continue
    // The API also lists retired and internal models. Only offer the ones
    // GitHub itself puts in front of users.
    if (!m.model_picker_enabled) continue
    models[id] = toConfigModel({ ...fromApiModel(m), cost: inheritCost(id, catalogue) })
    added.push(id)
  }
  return { models, added, disabled: found.disabled }
}

const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

/** models.dev prices, in USD per million tokens. Absent for API-discovered models. */
function toCost(cost: any) {
  if (!cost) return ZERO_COST
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cache_read: cost.cache_read ?? 0,
    cache_write: cost.cache_write ?? 0,
  }
}

/** Only pass through the fields OpenCode's provider config schema knows about. */
function toConfigModel(m: ModelsDevModel) {
  return {
    name: m.name,
    family: m.family,
    attachment: m.attachment ?? false,
    reasoning: m.reasoning ?? false,
    temperature: m.temperature ?? true,
    tool_call: m.tool_call ?? true,
    modalities: m.modalities,
    limit: m.limit,
    release_date: m.release_date,
    // Copilot bills premium requests, not tokens, so these prices are the underlying
    // vendor's list rates from models.dev — useful for comparing models, not a bill.
    cost: toCost(m.cost),
  }
}

/**
 * A newly released model has no models.dev entry, so no prices. Borrow them from the
 * closest catalogue sibling — the entry sharing the longest id prefix, e.g.
 * `claude-opus-5.5` from `claude-opus-5`. Approximate by construction, but a far better
 * estimate than zero, and only ever used for models the catalogue does not cover.
 */
function inheritCost(id: string, catalogue: Record<string, ModelsDevModel>) {
  const commonPrefix = (a: string, b: string) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  let best: { cost: any; score: number } | null = null
  for (const [otherId, m] of Object.entries(catalogue)) {
    if (!m.cost) continue
    const score = commonPrefix(id, otherId)
    // Require a real family match, not an incidental "g"/"c" overlap.
    if (score < 5) continue
    if (!best || score > best.score) best = { cost: m.cost, score }
  }
  return best?.cost
}

export const CopilotPatPlugin: Plugin = async (input: any) => {
  clientLog = (level, message) => {
    try {
      void input.client.app.log({ body: { service: "copilot-pat", level, message } }).catch(() => {})
    } catch {}
  }
  return {
    async config(config: any) {
      trace("config hook: start")
      const key = await storedKey()
      const [catalogue, found] = await Promise.all([loadCatalogue(), key ? discover(key) : null])
      const { models, added, disabled } = reconcile(catalogue, found)
      trace(`config hook: ${Object.keys(models).length} models, ${added.length} from API`)
      if (found)
        log(`${Object.keys(models).length} models usable on this account (${found.mode} mode)` +
          (added.length ? `; ${added.length} newer than the catalogue: ${added.join(", ")}` : "") +
          (disabled.length ? `; ${disabled.length} hidden until enabled in Copilot settings: ${disabled.join(", ")}` : ""))
      config.provider ??= {}
      const existing = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        ...existing,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? "@ai-sdk/github-copilot",
        api: existing.api ?? API_URL,
        options: { ...(existing.options ?? {}) },
        models: { ...models, ...(existing.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER_ID,
      // The config hook already reconciled the catalogue against /models using the
      // stored key. Redo it here with the auth context, which is authoritative and
      // also covers keys the config hook could not read.
      async models(provider: any, ctx: any) {
        trace(`models hook: auth=${ctx?.auth?.type}`)
        if (ctx?.auth?.type !== "api") return provider.models
        const found = await discover(ctx.auth.key)
        if (!found) return provider.models
        const kept: Record<string, any> = {}
        for (const [id, m] of Object.entries(provider.models)) if (found.usable.has(id)) kept[id] = m
        for (const [id, m] of found.usable) {
          if (kept[id] || !m.model_picker_enabled) continue
          kept[id] = toConfigModel({ ...fromApiModel(m), cost: inheritCost(id, provider.models) })
        }
        return Object.keys(kept).length ? kept : provider.models
      },
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [{ type: "api", label: "Fine-grained PAT with 'Copilot Requests' permission" }],
      async loader(getAuth: () => Promise<any>) {
        const info = await getAuth()
        trace(`loader: auth=${info?.type}`)
        if (!info || info.type !== "api") return {}
        return {
          baseURL: API_URL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const auth = await getAuth()
            trace(`fetch: ${request instanceof URL ? request.href : request.toString()} auth=${auth?.type}`)
            if (!auth || auth.type !== "api") return fetch(request, init)

            let bearer: { token: string; mode: Mode }
            try {
              bearer = await bearerFor(auth.key)
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e)
              log(message, "error")
              return new Response(JSON.stringify({ error: { message, type: "copilot_pat_auth_error", code: "token_exchange_failed" } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            }

            let isAgent = false
            let isVision = false
            try {
              const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
              const items: any[] = body?.messages ?? body?.input ?? []
              const last = items[items.length - 1]
              isAgent = !!last && last.role !== "user"
              isVision = items.some(
                (m) =>
                  Array.isArray(m?.content) &&
                  m.content.some((p: any) => p?.type === "image_url" || p?.type === "input_image" || p?.type === "image"),
              )
            } catch {}

            const headers = new Headers(init?.headers)
            headers.delete("x-api-key")
            for (const [k, v] of Object.entries(copilotHeaders(bearer.token, bearer.mode, { "x-initiator": isAgent ? "agent" : "user" })))
              headers.set(k, v)
            if (isVision) headers.set("Copilot-Vision-Request", "true")

            const res = await fetch(request, { ...init, headers })
            trace(`fetch: upstream ${res.status}`)
            if (!res.ok && (res.status === 400 || res.status === 401 || res.status === 403)) {
              const text = await res.clone().text()
              const hint = explainUpstream(res.status, text, auth.key)
              if (hint) {
                log(hint, "error")
                return new Response(JSON.stringify({ error: { message: `[copilot-pat] ${hint} (upstream: ${text.slice(0, 120)})`, type: "copilot_pat_auth_error" } }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                })
              }
            }
            return res
          },
        }
      },
    },
  }
}

export default CopilotPatPlugin

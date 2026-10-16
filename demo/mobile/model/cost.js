/**
 * Cost and Secure (Pro). The core has no spend or security-anomaly API, so
 * neither screen shows dollars or findings. Cost shows what the core DOES
 * report — LLM token spend today against the daily budget and this tenant's
 * cap (status.limits, the core's one budget answer), lifetime tokens for the tenant (tenantStats), and
 * voice quota — and says plainly that billing is not available.
 */
import { num } from "./format.js"
import { tenantEntry } from "./vitals.js"

export function buildCost(snap) {
  const st = snap?.status
  if (!st) return null
  const b = st.limits
  const t = snap.tenant
  const ts = tenantEntry(snap)
  const lt = b?.tenants?.[t]
  const cap = lt && num(lt.cap) > 0 ? lt.cap : undefined
  const v = st.voiceQuota
  const ev = ts?.events
  const gs = st.guardrailStats
  const guard = gs?.infraPassed != null || gs?.noiseDropped != null
  return {
    tokensToday: num(b?.spent) ?? null,
    tenantToday: num(lt?.spent) ?? (b ? 0 : null),
    tenantCap: num(cap) ?? null,
    dailyLimit: num(b?.cap) > 0 ? num(b.cap) : null,
    remaining: num(b?.cap) > 0 ? Math.max(0, num(b.cap) - num(b.spent)) : null,
    lifetimeTokens: num(ts?.llmTokens) ?? null,
    promptTokens: num(ts?.llmPromptTokens) ?? null,
    completionTokens: num(ts?.llmCompletionTokens) ?? null,
    calls: num(ts?.llmCalls) ?? null,
    voiceToday: num(v?.byTenant?.[t]) ?? null,
    voiceLimit: num(v?.tenantCaps?.[t] ?? v?.tenantCaps?.["*"] ?? v?.limit) ?? null,
    events: ev ? (ev.noise ?? 0) + (ev.signal ?? 0) + (ev.issue ?? 0) : null,
    // Calls = events the guardrail LLM evaluated; rejected = dropped as noise or injection.
    guardCalls: guard ? (gs?.infraPassed ?? 0) + (gs?.noiseDropped ?? 0) : null,
    guardRejected: guard ? (gs?.noiseDropped ?? 0) + (gs?.injectionDropped ?? 0) : null,
    voiceCalls: num(st.config?.voiceSessionsTotal) ?? null,
    embeddingCalls: num(st.classifierStats?.embeddingCalls) ?? null,
  }
}

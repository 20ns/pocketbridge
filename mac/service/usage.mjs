// Plan usage from each official CLI (Claude's get_usage, Codex's account/rateLimits/read) and Codex reset credits.
// No account identity is kept.
import { converse, codexCall, claudeProbeArgs } from './agents.mjs';
import { clean } from './util.mjs';

const planNames = { pro: 'Pro', max: 'Max', plus: 'Plus', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
const planName = value => typeof value === 'string' && value ? planNames[value.toLowerCase()] ?? value.replace(/(^|[_\s-])(\w)/g, (_, gap, letter) => (gap ? ' ' : '') + letter.toUpperCase()) : '';
const percent = value => Math.max(0, Math.min(100, Math.round(Number(value))));
const severity = (value, used) => ['normal', 'warning', 'critical'].includes(value) ? value : used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal';

/** Plan limits from Claude's own /usage data: session, weekly and any per-model weekly limit. */
export function normalizeClaudeUsage(response) {
  const limits = response?.rate_limits?.limits;
  if (!Array.isArray(limits)) return null;
  const label = limit => {
    const model = clean(limit.scope?.model?.display_name, 40);
    if (limit.kind === 'session') return '5-hour session';
    if (limit.kind === 'weekly_all') return 'Weekly';
    if (model) return `Weekly · ${model}`;
    return clean(String(limit.kind ?? 'Limit').replace(/_/g, ' '), 40);
  };
  const window = kind => kind === 'session' ? 'session' : String(kind ?? '').startsWith('weekly') ? 'weekly' : 'other';
  return {
    plan: planName(response.subscription_type),
    limits: limits.filter(limit => limit && Number.isFinite(Number(limit.percent))).map(limit => {
      const used = percent(limit.percent);
      return { id: `${limit.kind}${limit.scope?.model?.display_name ? `:${limit.scope.model.display_name}` : ''}`, label: label(limit), window: window(limit.kind), percent: used, resetsAt: Date.parse(limit.resets_at) || null, severity: severity(limit.severity, used) };
    }),
  };
}

export async function claudeUsage({ command, cwd, env, signal, timeoutMs }) {
  const response = await converse({
    command, cwd, env, signal, timeoutMs, args: claudeProbeArgs,
    start: write => { write({ type: 'control_request', request_id: 'pocketbridge-init', request: { subtype: 'initialize' } }); write({ type: 'control_request', request_id: 'pocketbridge-usage', request: { subtype: 'get_usage' } }); },
    onMessage: message => message.type === 'control_response' && message.response?.request_id === 'pocketbridge-usage' ? (message.response.response ?? null) : undefined,
  });
  return normalizeClaudeUsage(response);
}

/** Banked Codex limit resets that can be redeemed now. Null when the CLI didn't say. */
const resetCredits = summary => {
  if (!summary || typeof summary !== 'object' || !Number.isFinite(Number(summary.availableCount))) return null;
  const credits = (Array.isArray(summary.credits) ? summary.credits : [])
    .filter(credit => credit && typeof credit.id === 'string' && credit.id.length <= 200 && (credit.status ?? 'available') === 'available')
    .map(credit => ({ id: credit.id, title: clean(credit.title, 80) || null, description: clean(credit.description, 300) || null, expiresAt: Number(credit.expiresAt) > 0 ? Number(credit.expiresAt) * 1000 : null }));
  return { available: Math.max(0, Math.floor(Number(summary.availableCount))), credits };
};

/** Codex plan windows (usually 5-hour and weekly), any prepaid credit balance and banked resets. */
export function normalizeCodexUsage(result) {
  const limits = result?.rateLimits;
  if (!limits || typeof limits !== 'object') return null;
  const label = minutes => minutes === 300 ? '5-hour' : minutes === 10080 ? 'Weekly' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${Math.max(1, Math.round(minutes / 60))}-hour`;
  const window = minutes => minutes === 300 ? 'session' : minutes === 10080 ? 'weekly' : 'other';
  const windows = [['primary', limits.primary], ['secondary', limits.secondary]].filter(([, entry]) => entry && Number.isFinite(Number(entry.usedPercent)));
  const credits = limits.credits?.hasCredits && !limits.credits.unlimited && Number.isFinite(Number(limits.credits.balance)) ? Number(limits.credits.balance) : undefined;
  return {
    plan: planName(limits.planType),
    limits: windows.map(([id, entry]) => {
      const used = percent(entry.usedPercent), minutes = Number(entry.windowDurationMins);
      return { id, label: label(minutes), window: window(minutes), percent: used, resetsAt: Number(entry.resetsAt) > 0 ? Number(entry.resetsAt) * 1000 : null, severity: severity(null, used) };
    }),
    ...(credits !== undefined ? { credits } : {}),
    resets: resetCredits(result.rateLimitResetCredits),
  };
}

export async function codexUsage(probe) {
  const answer = await codexCall({ ...probe, method: 'account/rateLimits/read', params: {} });
  return normalizeCodexUsage(answer?.result);
}

export const resetOutcomes = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'];

/**
 * Redeems one banked Codex reset through the CLI. The idempotency key identifies one attempt, so a retry with the
 * same key cannot use a second credit. Resolves {outcome} or {error}; null when Codex didn't answer.
 */
export async function consumeCodexReset(probe, { idempotencyKey, creditId, ready }) {
  const answer = await codexCall({ ...probe, ready, method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey, ...(creditId ? { creditId } : {}) } });
  if (!answer || answer.cancelled) return answer;
  if (answer.error) return { error: clean(answer.error.message, 300) || 'Codex could not redeem the reset' };
  return resetOutcomes.includes(answer.result?.outcome) ? { outcome: answer.result.outcome } : { error: 'Codex gave an unknown reset outcome' };
}

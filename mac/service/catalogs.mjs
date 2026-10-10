// Per-agent service state: which CLI runs, whether it is on, its model catalog, plan usage and Codex resets.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { agentIds, agentNames, agentModes, agentEnv, newestCli, extraCliPaths, claudeCatalog, codexCatalog, checkModel, checkEffort, checkSpeed } from './agents.mjs';
import { claudeUsage, codexUsage, consumeCodexReset } from './usage.mjs';
import { fail, pause } from './util.mjs';

// Legacy capability lists for clients before 0.5; agents[] carries each CLI's own catalog.
export const legacyModels = ['default', 'opus', 'sonnet', 'haiku'];
export const legacyEfforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

export function createAgents(ctx) {
  const { options, testing, dataDir, setting, saveSetting } = ctx;
  // Tests never touch the real installs: they pass fake paths, and only the paths they name are asked.
  const explicit = { claude: options.claudePath, codex: options.codexPath };
  const configured = {
    claude: options.claudePath ?? process.env.POCKETBRIDGE_CLAUDE_PATH ?? 'claude',
    codex: options.codexPath ?? process.env.POCKETBRIDGE_CODEX_PATH ?? (testing ? null : 'codex'),
  };
  const fixed = { claude: options.claudeAvailable, codex: options.codexAvailable };
  const candidates = agent => [configured[agent], ...(options.cliCandidates?.[agent] ?? (explicit[agent] === undefined && !testing ? extraCliPaths(agent) : []))];
  const paths = { ...configured }, versions = { claude: null, codex: null }, available = { claude: false, codex: false };
  // The owner's switch per agent, for when only one subscription is active. Off means no probes, no discovery, no new turns.
  const enabled = Object.fromEntries(agentIds.map(agent => [agent, setting(`agentEnabled:${agent}`) !== '0']));

  /**
   * Uses the newest installed CLI: the configured path, the one on PATH and, for Codex, the copy inside the ChatGPT
   * or Codex app. Asked at startup and again with each catalog refresh, so an updated CLI and its models show up.
   * A later check that finds nothing keeps the last good choice. Resolves true when the choice changed.
   */
  const selectCli = async (agent, first = false) => {
    if (fixed[agent] !== undefined) { available[agent] = fixed[agent]; return false; }
    const before = `${paths[agent]} ${versions[agent]} ${available[agent]}`;
    const best = await newestCli(candidates(agent), options.versionTimeoutMs ?? 5000);
    if (best) { paths[agent] = best.path; versions[agent] = best.version; available[agent] = true; }
    else if (first) available[agent] = false;
    return before !== `${paths[agent]} ${versions[agent]} ${available[agent]}`;
  };
  const probe = (agent, cwd = dataDir) => ({ command: paths[agent], cwd, env: agentEnv(agent), signal: ctx.probes.signal, timeoutMs: options.catalogTimeoutMs ?? 20_000 });

  // Model catalogs come from each CLI's own picker. The last good one is kept for restarts and failed probes.
  const catalogs = {}, catalogAt = {}, catalogProbe = {};
  for (const agent of agentIds) { try { catalogs[agent] = JSON.parse(setting(`catalog:${agent}`) ?? 'null'); } catch { catalogs[agent] = null; } }
  const claudeSettingsPath = options.claudeSettingsPath ?? (testing ? null : join(homedir(), '.claude', 'settings.json'));
  const refreshCatalog = (agent, force = false, reselect = true) => {
    if (!enabled[agent] || ctx.closed || options.catalogs === false || (fixed[agent] !== undefined && !fixed[agent])) return Promise.resolve(catalogs[agent]);
    if (catalogProbe[agent]) return catalogProbe[agent];
    const age = Date.now() - (catalogAt[agent] ?? 0);
    if (!force && age < (catalogs[agent] || !available[agent] ? 30 * 60_000 : 60_000)) return Promise.resolve(catalogs[agent]);
    catalogAt[agent] = Date.now();
    catalogProbe[agent] = (async () => {
      let changed = reselect && await selectCli(agent);
      if (available[agent] && !ctx.closed) {
        const result = await (agent === 'claude' ? claudeCatalog({ ...probe(agent), settingsPath: claudeSettingsPath }) : codexCatalog(probe(agent))).catch(() => null);
        if (result && !ctx.closed && JSON.stringify(result) !== JSON.stringify(catalogs[agent])) {
          catalogs[agent] = result; saveSetting(`catalog:${agent}`, JSON.stringify(result)); changed = true;
        }
      }
      if (changed && !ctx.closed) ctx.change('state');
      return catalogs[agent];
    })().catch(() => catalogs[agent]).finally(() => { catalogProbe[agent] = null; });
    return catalogProbe[agent];
  };
  // A first prompt may arrive before the startup probe answers. Validation waits briefly, well inside client
  // timeouts, then falls back to the safe pattern checks while the probe finishes in the background.
  const catalogFor = async agent => catalogs[agent] ?? await Promise.race([refreshCatalog(agent), pause(options.catalogWaitMs ?? 2500).then(() => catalogs[agent] ?? null)]);
  const modelDisplay = (agent, value) => catalogs[agent]?.models.find(model => model.id === value || model.resolved === value)?.name ?? value;
  const agentCatalog = agent => {
    const catalog = catalogs[agent];
    return {
      id: agent, name: agentNames[agent], available: available[agent], enabled: enabled[agent], version: versions[agent], modes: agentModes[agent],
      defaultModel: catalog?.defaultModel ?? 'default', defaultEffort: catalog?.defaultEffort ?? 'default',
      models: (catalog?.models ?? []).map(({ resolved, ...model }) => ({ ...model, speeds: model.speeds ?? [] })),
    };
  };
  const setEnabled = (agent, value) => {
    enabled[agent] = value; saveSetting(`agentEnabled:${agent}`, value ? '1' : '0');
    if (value) { usageAt[agent] = 0; refreshCatalog(agent, true); }
  };

  // Plan usage, asked of each CLI at most once a minute and again after any turn ends.
  const usage = {}, usageAt = {}, usageProbe = {};
  const refreshUsage = agent => {
    if (!available[agent] || !enabled[agent] || ctx.closed || options.usage === false) return Promise.resolve(usage[agent] ?? null);
    if (usageProbe[agent]) return usageProbe[agent];
    if (Date.now() - (usageAt[agent] ?? 0) < 60_000) return Promise.resolve(usage[agent] ?? null);
    usageAt[agent] = Date.now();
    usageProbe[agent] = (agent === 'claude' ? claudeUsage(probe(agent)) : codexUsage(probe(agent))).catch(() => null).then(result => {
      usageProbe[agent] = null;
      if (result) usage[agent] = { ...result, updatedAt: Date.now() };
      // Limits that can't be refreshed for ten minutes are dropped rather than shown as current.
      else if (usage[agent] && Date.now() - usage[agent].updatedAt > 600_000) delete usage[agent];
      return usage[agent] ?? null;
    });
    return usageProbe[agent];
  };
  const usageReport = async () => Promise.all(agentIds.map(async agent => {
    const known = enabled[agent] ? await refreshUsage(agent) : null;
    return { id: agent, name: agentNames[agent], available: available[agent], enabled: enabled[agent], ...(known ?? { limits: [], ...(agent === 'codex' ? { resets: null } : {}) }) };
  }));
  const usageChanged = agent => { usageAt[agent] = 0; };

  // One redemption per idempotency key at a time; Codex itself answers alreadyRedeemed for a key it has used.
  const redeeming = new Map();
  const redeemReset = (key, creditId, ready) => {
    if (!enabled.codex) throw fail(409, 'Codex is turned off. Turn it on in Settings.');
    if (!available.codex) throw fail(409, 'Codex is not installed or could not be started');
    if (!redeeming.has(key)) redeeming.set(key, consumeCodexReset(probe('codex'), { idempotencyKey: key, creditId, ready }).finally(() => {
      redeeming.delete(key);
      // A probe already under way may predate the reset; the next one starts after it.
      Promise.resolve(usageProbe.codex).then(() => { usageAt.codex = 0; return refreshUsage('codex'); }).catch(() => {});
    }));
    return redeeming.get(key);
  };

  const mode = (value, agent) => { if (!agentModes[agent].includes(value)) throw fail(400, 'Unsupported permission mode'); return value; };
  /** Validates requested options against the agent's own catalog. Omitted values stay undefined. */
  const chatOptions = async (agent, input, stored) => {
    const chosenMode = input.mode === undefined ? undefined : mode(input.mode, agent);
    if (input.model === undefined && input.effort === undefined && input.speed === undefined) return { mode: chosenMode };
    const catalog = await catalogFor(agent);
    if (input.model !== undefined && !checkModel(agent, input.model, catalog)) throw fail(400, 'Unsupported model');
    const model = input.model ?? stored?.model ?? 'default';
    // A new model keeps the chat's effort only if that model supports it.
    if (input.model !== undefined && input.effort === undefined && stored?.effort && stored.effort !== 'default' && !checkEffort(agent, model, stored.effort, catalog)) throw fail(400, 'Unsupported effort for this model');
    // Clients before 0.5 send no agent and only know the legacy effort list, so they keep its rules.
    const effortCatalog = input.agent === undefined && legacyEfforts.includes(input.effort) ? null : catalog;
    if (input.effort !== undefined && (typeof input.effort !== 'string' || !checkEffort(agent, model, input.effort, effortCatalog))) throw fail(400, 'Unsupported effort for this model');
    let speed = input.speed;
    if (speed !== undefined && !checkSpeed(agent, model, speed, catalog)) throw fail(400, 'Unsupported speed for this model');
    // Speed is a billing tier, not a permission mode: a model without the chat's tier runs at standard speed.
    if (speed === undefined && input.model !== undefined && stored?.speed && catalog && !checkSpeed(agent, model, stored.speed, catalog)) speed = null;
    return { mode: chosenMode, model: input.model, effort: input.effort, speed };
  };

  /** Chooses each CLI at startup; catalogs are read afterwards with load(). */
  const select = () => Promise.all(agentIds.map(agent => selectCli(agent, true)));
  const load = () => Promise.all(agentIds.map(agent => refreshCatalog(agent, true, false)));
  return { paths, available, enabled, catalogs, versions, select, load, refreshCatalog, catalogFor, modelDisplay, agentCatalog, setEnabled, refreshUsage, usageReport, usageChanged, redeemReset, chatOptions, probe };
}

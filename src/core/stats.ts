export type ModelUsageSummary = {
  modelID: string
  providerID: string
  tokens: number
  costUsd: number
  steps: number
}

export type ProviderActivitySummary = {
  goTokens: number
  goSteps: number
  zenTokens: number
  zenCostUsd: number
  zenSteps: number
  totalCostUsd: number
  topModels: ModelUsageSummary[]
}

type ModelUsageLike = {
  model?: { providerID?: unknown; modelID?: unknown }
  steps?: unknown
  cost?: unknown
  tokens?: {
    input?: unknown
    output?: unknown
    reasoning?: unknown
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function summarizeStatsByProvider(models: readonly ModelUsageLike[] | undefined): ProviderActivitySummary {
  const out: ProviderActivitySummary = {
    goTokens: 0,
    goSteps: 0,
    zenTokens: 0,
    zenCostUsd: 0,
    zenSteps: 0,
    totalCostUsd: 0,
    topModels: [],
  }
  if (!models?.length) return out
  const byModel = new Map<string, ModelUsageSummary>()
  for (const item of models) {
    const provider = typeof item.model?.providerID === "string" ? item.model.providerID : ""
    const modelID = typeof item.model?.modelID === "string" ? item.model.modelID.trim() : ""
    const steps = num(item.steps)
    const cost = num(item.cost)
    const tokens = num(item.tokens?.input) + num(item.tokens?.output) + num(item.tokens?.reasoning)
    out.totalCostUsd += cost
    if (provider === "opencode-go") {
      out.goSteps += steps
      out.goTokens += tokens
    } else if (provider === "opencode") {
      out.zenSteps += steps
      out.zenTokens += tokens
      out.zenCostUsd += cost
    }
    if ((provider === "opencode-go" || provider === "opencode") && modelID && (tokens > 0 || cost > 0)) {
      const key = `${provider}/${modelID}`
      const prev = byModel.get(key)
      if (prev) {
        prev.tokens += tokens
        prev.costUsd += cost
        prev.steps += steps
      } else {
        byModel.set(key, { modelID, providerID: provider, tokens, costUsd: cost, steps })
      }
    }
  }
  out.topModels = [...byModel.values()]
    .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd)
    .slice(0, 3)
  return out
}

export function formatTokensCompact(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count >= 999_950) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(Math.round(count))
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

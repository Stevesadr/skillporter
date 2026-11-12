/**
 * Tool limits are ours, not the agents'. They exist so an untrusted skill cannot
 * exhaust memory or make a conversion take forever. They are reported with
 * `scope: 'tool'` everywhere so nobody confuses them with a target agent's limits.
 */
export interface ToolLimits {
  /** Largest single bundled file we will read. */
  maxFileBytes: number;
  /** Largest number of bundled files we will enumerate. */
  maxFiles: number;
  /** Largest total size of bundled files. */
  maxTotalBytes: number;
  /** Deepest directory nesting below the skill root we will walk. */
  maxDepth: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 500,
  maxTotalBytes: 50 * 1024 * 1024,
  maxDepth: 8,
};

export function resolveLimits(overrides: Partial<ToolLimits> | undefined): ToolLimits {
  const limits: ToolLimits = { ...DEFAULT_TOOL_LIMITS };
  for (const key of Object.keys(DEFAULT_TOOL_LIMITS) as (keyof ToolLimits)[]) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`tool limit ${key} must be a positive number, got ${String(value)}`);
    }
    limits[key] = Math.floor(value);
  }
  return limits;
}

export function describeLimits(limits: ToolLimits): ToolLimits & { scope: 'tool' } {
  return { scope: 'tool', ...limits };
}

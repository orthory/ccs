// Subscription readings belong to an account and a polled window.
// Expired readings remain unknown until CCS polls again; they never imply zero usage.

// ── Types ──────────────────────────────────────────────────────

export type Provider = "claude" | "codex";

export interface Limit {
  kind: string;
  percent: number;
  resets_at: string | null;
  scope: { model: { display_name: string } } | null;
}

export interface Account {
  provider: Provider;
  slug: string;
  email: string;
  plan: string;
  active: boolean;
  polled_at: string | null;
  limits?: Limit[];
  error?: string;
  model_usage?: Record<string, {
    available: boolean;
    available_at: string | null;
    credits_would_enable: boolean;
  }>;
}

export type Paint = (color: "muted" | "success" | "warning" | "error" | "accent", text: string) => string;

// ── Window formatting ──────────────────────────────────────────

export const countdown = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${minutes}m`;
};

const label = (limit: Limit): string => {
  const scoped = limit.scope?.model.display_name;
  switch (limit.kind) {
    case "session": return scoped ? `${scoped} 5h` : "5h";
    case "weekly_all": return scoped ? `${scoped} wk` : "wk";
    case "weekly_scoped": return scoped || "scoped wk";
    default: return [scoped, limit.kind].filter(Boolean).join(" ");
  }
};

const windowText = (limit: Limit, now: number, paint: Paint): string => {
  const reset = limit.resets_at ? Date.parse(limit.resets_at) : undefined;
  const expired = reset !== undefined && reset <= now;
  if (expired) return paint("muted", `${label(limit)} ? (refresh)`);
  const color = usageColor(limit.percent);
  const remaining = reset === undefined ? "" : ` ↺${countdown(reset - now)}`;
  return `${label(limit)} ${paint(color, `${Math.round(limit.percent)}%`)}${paint("muted", remaining)}`;
};

const usageColor = (percent: number): "error" | "warning" | "success" => {
  if (percent >= 80) return "error";
  if (percent >= 50) return "warning";
  return "success";
};

// ── Account formatting ─────────────────────────────────────────

export const accountText = (account: Account, now: number, paint: Paint): string => {
  const limits = (account.limits || []).filter(limit => limit.scope?.model.display_name !== "GPT-5.3-Codex-Spark");
  const windows = limits.map(limit => windowText(limit, now, paint));
  const availability = Object.entries(account.model_usage || {}).map(([model, usage]) => {
    const when = usage.available_at ? Date.parse(usage.available_at) : undefined;
    const waiting = when !== undefined && when > now;
    const unavailable = waiting ? `back ${countdown(when - now)}` : "unavailable";
    const status = usage.available ? "available" : unavailable;
    const credits = usage.credits_would_enable ? " · credits unlock" : "";
    return `${model} ${status}${credits}`;
  });
  const reading = account.polled_at ? `read ${countdown(now - Date.parse(account.polled_at))} ago` : "not polled";
  const details = [...windows, ...availability, account.error, paint("muted", reading)].filter(Boolean);
  return `${paint("accent", account.email)} · ${account.plan} │ ${details.join(" · ")}`;
};

export const providerFor = (name: string | undefined): Provider | undefined => {
  switch (name) {
    case "anthropic": return "claude";
    case "openai-codex": return "codex";
    default: return undefined;
  }
};

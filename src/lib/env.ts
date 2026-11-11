export function getEnv(name: string, required = true): string | undefined {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const appConfig = {
  name: "PlayMind Trader Twins",
  description: "Evidence-first policy testing on behavioral trader twins.",
  liveTradingEnabled: false,
  customerDataMode: process.env.CUSTOMER_DATA_MODE ?? "tokenized-only",
};

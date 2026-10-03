export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AdapterConfig {
  hermesApiUrl: URL;
  hermesApiKey: string;
  port: number;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && octets[0] === "127";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const hermesApiKey = environment.HERMES_API_KEY;
  if (!hermesApiKey) {
    throw new ConfigError("HERMES_API_KEY is required");
  }
  if (hermesApiKey.length < 16) {
    throw new ConfigError("HERMES_API_KEY must be at least 16 characters");
  }

  let hermesApiUrl: URL;
  try {
    hermesApiUrl = new URL(environment.HERMES_API_URL ?? "http://127.0.0.1:8642");
  } catch {
    throw new ConfigError("HERMES_API_URL must be a valid URL");
  }
  if (hermesApiUrl.protocol !== "http:" && hermesApiUrl.protocol !== "https:") {
    throw new ConfigError("HERMES_API_URL must use http or https");
  }
  if (hermesApiUrl.hostname.toLowerCase() === "localhost") {
    throw new ConfigError("HERMES_API_URL must use a literal loopback IP");
  }
  if (!isLoopbackHost(hermesApiUrl.hostname)) {
    throw new ConfigError("HERMES_API_URL must use a loopback host");
  }
  if (hermesApiUrl.username || hermesApiUrl.password) {
    throw new ConfigError("HERMES_API_URL must not contain credentials");
  }

  const port = Number(environment.PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be a valid TCP port");
  }

  return { hermesApiUrl, hermesApiKey, port };
}

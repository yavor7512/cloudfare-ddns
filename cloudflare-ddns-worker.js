const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_UPDATE_PATH = "/update";

const TEXT_HEADERS = {
  "Content-Type": "text/plain;charset=UTF-8",
  "Cache-Control": "no-store"
};

const BASIC_AUTH_PATTERN = /^ *Basic +([A-Za-z0-9._~+/-]+=*) *$/i;
const CONTROL_CHARACTER_PATTERN = /[\0-\x1F\x7F]/;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_OCTET_PATTERN = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4_ADDRESS_PATTERN = new RegExp(
  `^${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}$`
);

/*
Required Worker secrets / variables:
  CF_API_TOKEN      Cloudflare API token with Zone:DNS:Edit for this zone
  DDNS_USERNAME    Basic auth username configured on your router
  DDNS_PASSWORD    Basic auth password configured on your router
  DDNS_HOSTNAME    Single DNS record to update, for example home.example.com
  CF_ZONE_ID       Preferred: Cloudflare zone id. Set CF_ZONE_NAME instead if needed.

Optional:
  CF_ZONE_NAME       Used only when CF_ZONE_ID is not set, for example example.com
  DDNS_RECORD_TYPE   A or AAAA. Defaults to the address family of the submitted IP.
  DDNS_UPDATE_PATH   Defaults to /update. Use /nic/update if your router expects that.
*/

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.statusText = options.statusText;
    this.publicMessage = options.publicMessage ?? message;
    this.headers = options.headers ?? {};
  }
}

class BadRequestError extends HttpError {
  constructor(message) {
    super(400, message, { statusText: "Bad Request" });
  }
}

class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized.") {
    super(401, message, {
      statusText: "Unauthorized",
      publicMessage: "Unauthorized.",
      headers: {
        "WWW-Authenticate": 'Basic realm="Cloudflare DDNS", charset="UTF-8"'
      }
    });
  }
}

class ForbiddenError extends HttpError {
  constructor(message) {
    super(403, message, { statusText: "Forbidden" });
  }
}

class ConfigurationError extends HttpError {
  constructor(message) {
    super(500, message, {
      statusText: "Internal Server Error",
      publicMessage: "Worker is not configured."
    });
  }
}

class CloudflareApiError extends HttpError {
  constructor(message) {
    super(502, message, {
      statusText: "Bad Gateway",
      publicMessage: "Cloudflare API request failed."
    });
  }
}

class CloudflareClient {
  constructor(apiToken) {
    this.apiToken = apiToken;
  }

  async findZoneByName(zoneName) {
    const params = new URLSearchParams({
      name: zoneName,
      status: "active",
      per_page: "1"
    });

    const body = await this.request(`/zones?${params}`);
    const zone = body.result?.[0];

    if (!zone?.id) {
      throw new ConfigurationError(`Cloudflare zone '${zoneName}' was not found.`);
    }

    return zone;
  }

  async findDnsRecord(zoneId, hostname, recordType) {
    const params = new URLSearchParams({
      type: recordType,
      name: hostname,
      per_page: "2"
    });

    const body = await this.request(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${params}`
    );
    const records = body.result ?? [];

    if (records.length === 0) {
      throw new ConfigurationError(
        `${recordType} record '${hostname}' was not found in the configured zone.`
      );
    }

    if (records.length > 1 || (body.result_info?.total_count ?? 0) > 1) {
      throw new ConfigurationError(
        `More than one ${recordType} record named '${hostname}' was found.`
      );
    }

    return records[0];
  }

  async updateDnsRecordContent(zoneId, record, content) {
    const body = await this.request(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content })
      }
    );

    if (!body.result?.id) {
      throw new CloudflareApiError(
        `Cloudflare did not return the updated DNS record '${record.id}'.`
      );
    }

    return body.result;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${this.apiToken}`);

    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      headers
    });
    const body = await parseCloudflareJson(response);

    if (!response.ok || body.success === false) {
      const summary = summarizeCloudflareErrors(body);
      throw new CloudflareApiError(
        `Cloudflare API ${response.status} ${response.statusText}${summary}`
      );
    }

    return body;
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("DDNS worker request failed", error);
      return errorResponse(error);
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const updatePath = normalizePath(optionalEnv(env, "DDNS_UPDATE_PATH") ?? DEFAULT_UPDATE_PATH);

  if (url.pathname !== updatePath) {
    return textResponse("Not Found.", { status: 404 });
  }

  requireHttps(request, url);

  if (request.method !== "GET" && request.method !== "POST") {
    return textResponse("Method Not Allowed.", {
      status: 405,
      statusText: "Method Not Allowed",
      headers: { Allow: "GET, POST" }
    });
  }

  const config = readConfig(env, updatePath);
  const credentials = parseBasicAuth(request.headers.get("Authorization"));
  requireAuthorized(credentials, config);

  const hostname = resolveHostname(url.searchParams, config);
  const ip = resolveIpAddress(url.searchParams, request.headers);
  const recordType = resolveRecordType(config, ip);

  const cloudflare = new CloudflareClient(config.cloudflareApiToken);
  const zoneId = config.zoneId ?? (await cloudflare.findZoneByName(config.zoneName)).id;
  const record = await cloudflare.findDnsRecord(zoneId, hostname, recordType);

  if (record.content === ip.address) {
    return textResponse(`nochg ${ip.address}`);
  }

  const updatedRecord = await cloudflare.updateDnsRecordContent(
    zoneId,
    record,
    ip.address
  );

  return textResponse(`good ${updatedRecord.content}`);
}

function readConfig(env, updatePath) {
  const cloudflareApiToken = requireEnv(env, "CF_API_TOKEN");
  const username = requireEnv(env, "DDNS_USERNAME");
  const password = requireEnv(env, "DDNS_PASSWORD", { trim: false });

  validateBasicAuthSecret("DDNS_USERNAME", username, { allowColon: false });
  validateBasicAuthSecret("DDNS_PASSWORD", password, { allowColon: true });

  const hostname = normalizeConfiguredHostname(
    requireEnv(env, "DDNS_HOSTNAME"),
    "DDNS_HOSTNAME"
  );
  const zoneId = optionalEnv(env, "CF_ZONE_ID");
  const rawZoneName = optionalEnv(env, "CF_ZONE_NAME");
  const zoneName = rawZoneName
    ? normalizeConfiguredHostname(rawZoneName, "CF_ZONE_NAME")
    : undefined;
  const recordType = normalizeConfiguredRecordType(optionalEnv(env, "DDNS_RECORD_TYPE"));
  if (!zoneId && !zoneName) {
    throw new ConfigurationError("Set either CF_ZONE_ID or CF_ZONE_NAME.");
  }

  if (zoneName && !hostnameBelongsToZone(hostname, zoneName)) {
    throw new ConfigurationError(
      `DDNS_HOSTNAME '${hostname}' is not inside CF_ZONE_NAME '${zoneName}'.`
    );
  }

  return {
    cloudflareApiToken,
    hostname,
    password,
    recordType,
    updatePath,
    username,
    zoneId,
    zoneName
  };
}

function requireEnv(env, name, options = {}) {
  const value = optionalEnv(env, name, options);

  if (!value) {
    throw new ConfigurationError(`Missing required Worker variable '${name}'.`);
  }

  return value;
}

function optionalEnv(env, name, options = {}) {
  const value = env?.[name];

  if (typeof value !== "string") {
    return undefined;
  }

  return options.trim === false ? value : value.trim();
}

function validateBasicAuthSecret(name, value, options) {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new ConfigurationError(`${name} must not contain control characters.`);
  }

  if (!options.allowColon && value.includes(":")) {
    throw new ConfigurationError(`${name} must not contain a colon.`);
  }
}

function normalizeConfiguredHostname(value, variableName) {
  const hostname = normalizeHostname(value);

  if (!isValidHostname(hostname)) {
    throw new ConfigurationError(`${variableName} is not a valid hostname.`);
  }

  return hostname;
}

function normalizeRequestedHostname(value) {
  const hostname = normalizeHostname(value);

  if (!isValidHostname(hostname)) {
    throw new BadRequestError("Invalid hostname.");
  }

  return hostname;
}

function normalizeHostname(value) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isValidHostname(hostname) {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }

  if (isValidIpv4(hostname)) {
    return false;
  }

  const labels = hostname.split(".");
  const topLevelLabel = labels.at(-1);

  if (labels.length < 2 || topLevelLabel.length < 2 || !/[a-z]/.test(topLevelLabel)) {
    return false;
  }

  return labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}

function hostnameBelongsToZone(hostname, zoneName) {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}

function normalizeConfiguredRecordType(value) {
  if (!value) {
    return undefined;
  }

  const recordType = value.toUpperCase();

  if (recordType !== "A" && recordType !== "AAAA") {
    throw new ConfigurationError("DDNS_RECORD_TYPE must be A or AAAA.");
  }

  return recordType;
}

function normalizePath(value) {
  const path = value.trim();

  if (!path) {
    return DEFAULT_UPDATE_PATH;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function requireHttps(request, url) {
  const forwardedProtocol = request.headers.get("x-forwarded-proto");

  if (url.protocol !== "https:" && forwardedProtocol !== "https") {
    throw new BadRequestError("Please use a HTTPS connection.");
  }
}

function parseBasicAuth(header) {
  if (!header) {
    throw new UnauthorizedError();
  }

  const match = header.match(BASIC_AUTH_PATTERN);

  if (!match) {
    throw new UnauthorizedError("Unsupported authorization scheme.");
  }

  let decoded;

  try {
    decoded = decodeBase64Utf8(match[1]);
  } catch {
    throw new UnauthorizedError("Invalid authorization value.");
  }

  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1 || CONTROL_CHARACTER_PATTERN.test(decoded)) {
    throw new UnauthorizedError("Invalid authorization value.");
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requireAuthorized(credentials, config) {
  const usernameMatches = constantTimeEqual(credentials.username, config.username);
  const passwordMatches = constantTimeEqual(credentials.password, config.password);

  if (!usernameMatches || !passwordMatches) {
    throw new UnauthorizedError();
  }
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function resolveHostname(searchParams, config) {
  const requested = firstSearchParam(searchParams, ["hostname", "host", "domains"]);

  if (!requested) {
    return config.hostname;
  }

  const hostname = normalizeRequestedHostname(singleValue(requested, "hostname"));

  if (hostname !== config.hostname) {
    throw new ForbiddenError("Hostname is not allowed.");
  }

  return hostname;
}

function resolveIpAddress(searchParams, headers) {
  const requested =
    firstSearchParam(searchParams, ["myip", "ip", "ips"]) ||
    headers.get("CF-Connecting-IP");

  if (!requested) {
    throw new BadRequestError("You must specify an IP address.");
  }

  const address = singleValue(requested, "IP address");

  if (isValidIpv4(address)) {
    return { address, recordType: "A" };
  }

  const ipv6Address = normalizeIpv6(address);

  if (ipv6Address) {
    return { address: ipv6Address, recordType: "AAAA" };
  }

  throw new BadRequestError("Invalid IP address.");
}

function resolveRecordType(config, ip) {
  const recordType = config.recordType ?? ip.recordType;

  if (recordType !== ip.recordType) {
    throw new BadRequestError(
      `${recordType} records require a matching IP address family.`
    );
  }

  return recordType;
}

function firstSearchParam(searchParams, names) {
  for (const name of names) {
    const value = searchParams.get(name);

    if (value?.trim()) {
      return value;
    }
  }

  return undefined;
}

function singleValue(rawValue, label) {
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length !== 1) {
    throw new BadRequestError(`${label} must contain exactly one value.`);
  }

  return values[0];
}

function isValidIpv4(value) {
  return IPV4_ADDRESS_PATTERN.test(value);
}

function normalizeIpv6(value) {
  if (!value.includes(":") || value.includes("%")) {
    return undefined;
  }

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

async function parseCloudflareJson(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CloudflareApiError(
      `Cloudflare API returned a non-JSON response with HTTP ${response.status}.`
    );
  }
}

function summarizeCloudflareErrors(body) {
  const messages = (body.errors ?? [])
    .map((error) => {
      const code = error.code ? `${error.code}: ` : "";
      return error.message ? `${code}${error.message}` : "";
    })
    .filter(Boolean)
    .slice(0, 3);

  if (messages.length === 0) {
    return "";
  }

  return `: ${messages.join("; ")}`.slice(0, 500);
}

function textResponse(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: {
      ...TEXT_HEADERS,
      ...options.headers
    }
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return textResponse(error.publicMessage, {
      status: error.status,
      statusText: error.statusText,
      headers: error.headers
    });
  }

  return textResponse("Internal Server Error", {
    status: 500,
    statusText: "Internal Server Error"
  });
}

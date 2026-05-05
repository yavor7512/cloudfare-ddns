import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import worker from "./cloudflare-ddns-worker.js";

const require = createRequire(import.meta.url);
const basicAuthLibrary = require("basic-auth");
const ipaddr = require("ipaddr.js");
const validator = require("validator");

const BASE_ENV = {
  CF_API_TOKEN: "cf-token",
  CF_ZONE_ID: "zone-123",
  DDNS_USERNAME: "router",
  DDNS_PASSWORD: "router-secret",
  DDNS_HOSTNAME: "home.example.com"
};

test("updates the configured A record and returns a DynDNS good response", async () => {
  await withMockedFetch(async (url, init) => {
    if (url.includes("/dns_records?")) {
      assert.equal(init.method ?? "GET", "GET");
      assert.equal(init.headers.get("Authorization"), "Bearer cf-token");

      const query = new URL(url).searchParams;
      assert.equal(query.get("type"), "A");
      assert.equal(query.get("name"), "home.example.com");

      return cloudflareJson({
        success: true,
        result: [
          {
            id: "record-123",
            type: "A",
            name: "home.example.com",
            content: "198.51.100.10"
          }
        ],
        result_info: { total_count: 1 }
      });
    }

    assert.equal(init.method, "PATCH");
    assert.equal(url, "https://api.cloudflare.com/client/v4/zones/zone-123/dns_records/record-123");
    assert.deepEqual(JSON.parse(init.body), { content: "203.0.113.25" });

    return cloudflareJson({
      success: true,
      result: {
        id: "record-123",
        type: "A",
        name: "home.example.com",
        content: "203.0.113.25"
      }
    });
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.25");

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "good 203.0.113.25");
    assert.equal(calls.length, 2);
  });
});

test("returns nochg and skips Cloudflare update when the record already matches", async () => {
  await withMockedFetch(async () => {
    return cloudflareJson({
      success: true,
      result: [
        {
          id: "record-123",
          type: "A",
          name: "home.example.com",
          content: "203.0.113.25"
        }
      ],
      result_info: { total_count: 1 }
    });
  }, async (calls) => {
    const response = await dispatch("/update?ip=203.0.113.25");

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "nochg 203.0.113.25");
    assert.equal(calls.length, 1);
  });
});

test("accepts the configured hostname when a router sends hostname explicitly", async () => {
  await withMockedFetch(async (url, init) => {
    if (url.includes("/dns_records?")) {
      return cloudflareJson({
        success: true,
        result: [
          {
            id: "record-123",
            type: "A",
            name: "home.example.com",
            content: "198.51.100.10"
          }
        ],
        result_info: { total_count: 1 }
      });
    }

    assert.equal(init.method, "PATCH");

    return cloudflareJson({
      success: true,
      result: { id: "record-123", content: "203.0.113.25" }
    });
  }, async () => {
    const response = await dispatch(
      "/update?hostname=home.example.com&myip=203.0.113.25"
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "good 203.0.113.25");
  });
});

test("rejects attempts to update a hostname other than the configured record", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch(
      "/update?hostname=other.example.com&myip=203.0.113.25",
      { muteErrors: true }
    );

    assert.equal(response.status, 403);
    assert.equal(await response.text(), "Hostname is not allowed.");
    assert.equal(calls.length, 0);
  });
});

test("can resolve the zone id from CF_ZONE_NAME when CF_ZONE_ID is not set", async () => {
  const env = {
    ...BASE_ENV,
    CF_ZONE_ID: undefined,
    CF_ZONE_NAME: "example.com"
  };

  await withMockedFetch(async (url, init) => {
    if (url.includes("/zones?")) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("name"), "example.com");
      assert.equal(query.get("status"), "active");

      return cloudflareJson({
        success: true,
        result: [{ id: "resolved-zone-456", name: "example.com" }]
      });
    }

    if (url.includes("/dns_records?")) {
      assert.equal(url.startsWith("https://api.cloudflare.com/client/v4/zones/resolved-zone-456"), true);

      return cloudflareJson({
        success: true,
        result: [
          {
            id: "record-123",
            type: "A",
            name: "home.example.com",
            content: "198.51.100.10"
          }
        ],
        result_info: { total_count: 1 }
      });
    }

    assert.equal(init.method, "PATCH");

    return cloudflareJson({
      success: true,
      result: { id: "record-123", content: "203.0.113.25" }
    });
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.25", { env });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "good 203.0.113.25");
    assert.equal(calls.length, 3);
  });
});

test("updates AAAA records for IPv6 addresses", async () => {
  const ipv6 = "2001:db8::25";

  await withMockedFetch(async (url, init) => {
    if (url.includes("/dns_records?")) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("type"), "AAAA");

      return cloudflareJson({
        success: true,
        result: [
          {
            id: "record-v6",
            type: "AAAA",
            name: "home.example.com",
            content: "2001:db8::1"
          }
        ],
        result_info: { total_count: 1 }
      });
    }

    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body), { content: ipv6 });

    return cloudflareJson({
      success: true,
      result: { id: "record-v6", content: ipv6 }
    });
  }, async () => {
    const response = await dispatch(`/update?myip=${encodeURIComponent(ipv6)}`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), `good ${ipv6}`);
  });
});

test("normalizes IPv6 text before comparing with the current DNS value", async () => {
  await withMockedFetch(async () => {
    return cloudflareJson({
      success: true,
      result: [
        {
          id: "record-v6",
          type: "AAAA",
          name: "home.example.com",
          content: "2001:db8::1"
        }
      ],
      result_info: { total_count: 1 }
    });
  }, async (calls) => {
    const response = await dispatch(
      "/update?myip=2001:0DB8:0000:0000:0000:0000:0000:0001"
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "nochg 2001:db8::1");
    assert.equal(calls.length, 1);
  });
});

test("rejects invalid Basic auth before calling Cloudflare", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.25", {
      authorization: basicAuth("router", "wrong-password"),
      muteErrors: true
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), 'Basic realm="Cloudflare DDNS", charset="UTF-8"');
    assert.equal(await response.text(), "Unauthorized.");
    assert.equal(calls.length, 0);
  });
});

test("rejects malformed Basic auth tokens before calling Cloudflare", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.25", {
      authorization: "Basic cm91dGVyOnJvdXRlci1zZWNyZXQ= trailing",
      muteErrors: true
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Unauthorized.");
    assert.equal(calls.length, 0);
  });
});

test("rejects invalid IP addresses before calling Cloudflare", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch("/update?myip=999.0.0.1", {
      muteErrors: true
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid IP address.");
    assert.equal(calls.length, 0);
  });
});

test("rejects IPv4 addresses with leading-zero octets", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.025", {
      muteErrors: true
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid IP address.");
    assert.equal(calls.length, 0);
  });
});

test("rejects dotted-decimal-looking configured hostnames", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const response = await dispatch("/update?myip=203.0.113.25", {
      env: {
        ...BASE_ENV,
        DDNS_HOSTNAME: "198.51.100.10"
      },
      muteErrors: true
    });

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Worker is not configured.");
    assert.equal(calls.length, 0);
  });
});

test("returns 404 for other paths without requiring configuration", async () => {
  await withMockedFetch(async () => {
    throw new Error("Cloudflare API should not be called");
  }, async (calls) => {
    const request = new Request("https://worker.example.com/not-update");
    const response = await worker.fetch(request, {});

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not Found.");
    assert.equal(calls.length, 0);
  });
});

test("IPv4 parsing matches reputable strict four-part decimal validators", async (t) => {
  const samples = [
    "0.0.0.0",
    "1.2.3.4",
    "203.0.113.25",
    "255.255.255.255",
    "01.2.3.4",
    "1.2.3",
    "1.2.3.4.5",
    "256.0.0.1",
    "1.2.3.04",
    "0x1.2.3.4",
    "1.2.3.-4"
  ];

  for (const address of samples) {
    await t.test(address, async () => {
      const expected =
        validator.isIP(address, { version: 4 }) &&
        ipaddr.IPv4.isValidFourPartDecimal(address);

      assert.equal(await workerAcceptsIp(address), expected);
    });
  }
});

test("legacy IPv4 forms accepted by broad libraries remain rejected here", async (t) => {
  const samples = [
    "0300.0250.1.1",
    "0xc0.0xa8.1.1",
    "3232235777",
    "192.168.1"
  ];

  for (const address of samples) {
    await t.test(address, async () => {
      assert.equal(ipaddr.IPv4.isValid(address), true);
      assert.equal(ipaddr.IPv4.isValidFourPartDecimal(address), false);
      assert.equal(await workerAcceptsIp(address), false);
    });
  }
});

test("IPv6 parsing tracks validator.js and normalizes through the platform URL parser", async (t) => {
  const samples = [
    "2001:db8::1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "::1",
    "::",
    "2001:db8::192.0.2.1",
    "2001:db8:::1",
    "2001:db8::g",
    "1:2:3:4:5:6:7:8:9",
    "12345::"
  ];

  for (const address of samples) {
    await t.test(address, async () => {
      assert.equal(await workerAcceptsIp(address), validator.isIP(address, { version: 6 }));
    });
  }
});

test("zone-scoped IPv6 strings are library-parseable but rejected for DNS record content", async () => {
  const address = "fe80::1%eth0";

  assert.equal(validator.isIP(address, { version: 6 }), true);
  assert.equal(ipaddr.IPv6.isValid(address), true);
  assert.equal(await workerAcceptsIp(address), false);
});

test("ASCII hostname validation matches validator.js FQDN behavior", async (t) => {
  const samples = [
    "home.example.com",
    "home.example.com.",
    "a-1.example.co",
    "xn--maana-pta.com",
    "localhost",
    "home.example.c",
    "example.123",
    "_acme-challenge.example.com",
    "-bad.example.com",
    "bad-.example.com",
    `${"a".repeat(64)}.example.com`,
    "198.51.100.10"
  ];

  for (const hostname of samples) {
    await t.test(hostname, async () => {
      const expected = validator.isFQDN(hostname, { allow_trailing_dot: true });
      assert.equal(await workerAcceptsConfiguredHostname(hostname), expected);
    });
  }
});

test("Unicode hostnames must be configured as punycode", async () => {
  assert.equal(validator.isFQDN("mañana.com"), true);
  assert.equal(await workerAcceptsConfiguredHostname("mañana.com"), false);
  assert.equal(await workerAcceptsConfiguredHostname("xn--maana-pta.com"), true);
});

test("Basic auth syntax follows jshttp/basic-auth before credential comparison", async () => {
  const validHeader = basicAuth("router", "router-secret");
  const parsed = basicAuthLibrary.parse(validHeader);

  assert.equal(parsed.name, "router");
  assert.equal(parsed.pass, "router-secret");
  assert.equal(await workerAcceptsAuthorization(validHeader), true);

  const invalidHeader = `${validHeader} trailing`;
  assert.equal(basicAuthLibrary.parse(invalidHeader), undefined);
  assert.equal(await workerAcceptsAuthorization(invalidHeader), false);
});

async function workerAcceptsIp(address) {
  return withMockedFetch(mockSuccessfulCloudflareApi, async () => {
    const response = await dispatch(`/update?myip=${encodeURIComponent(address)}`, {
      muteErrors: true
    });

    return response.status === 200;
  });
}

async function workerAcceptsConfiguredHostname(hostname) {
  return withMockedFetch(mockSuccessfulCloudflareApi, async () => {
    const response = await dispatch("/update?myip=203.0.113.25", {
      env: {
        ...BASE_ENV,
        DDNS_HOSTNAME: hostname
      },
      muteErrors: true
    });

    return response.status === 200;
  });
}

async function workerAcceptsAuthorization(authorization) {
  return withMockedFetch(mockSuccessfulCloudflareApi, async () => {
    const response = await dispatch("/update?myip=203.0.113.25", {
      authorization,
      muteErrors: true
    });

    return response.status === 200;
  });
}

function mockSuccessfulCloudflareApi(url, init) {
  if (url.includes("/dns_records?")) {
    const query = new URL(url).searchParams;
    const recordType = query.get("type");
    const currentContent = recordType === "AAAA" ? "2001:db8::ffff" : "198.51.100.10";

    return cloudflareJson({
      success: true,
      result: [
        {
          id: "record-123",
          type: recordType,
          name: query.get("name"),
          content: currentContent
        }
      ],
      result_info: { total_count: 1 }
    });
  }

  assert.equal(init.method, "PATCH");

  return cloudflareJson({
    success: true,
    result: {
      id: "record-123",
      content: JSON.parse(init.body).content
    }
  });
}

async function dispatch(pathAndQuery, options = {}) {
  const env = options.env ?? BASE_ENV;
  const authorization = options.authorization ?? basicAuth("router", "router-secret");
  const headers = new Headers(options.headers);
  headers.set("Authorization", authorization);

  const request = new Request(`https://worker.example.com${pathAndQuery}`, {
    method: options.method ?? "GET",
    headers
  });

  if (options.muteErrors) {
    return withMutedConsoleErrors(() => worker.fetch(request, env));
  }

  return worker.fetch(request, env);
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function cloudflareJson(body, init = {}) {
  return Response.json(body, init);
}

async function withMockedFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const normalizedInit = {
      ...init,
      headers: new Headers(init.headers)
    };

    calls.push({ url, init: normalizedInit });

    return handler(url, normalizedInit, calls);
  };

  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withMutedConsoleErrors(callback) {
  const originalError = console.error;
  console.error = () => {};

  try {
    return await callback();
  } finally {
    console.error = originalError;
  }
}

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { SecureClient } from "tinfoil";

loadEnvFile(new URL("../../.env", import.meta.url));

const serverBaseUrl = (process.env.AMBIENT_E2E_SERVER_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000")
  .replace(/\/+$/, "");
const callbackHost = "127.0.0.1";
const callbackPort = Number(process.env.AMBIENT_E2E_CALLBACK_PORT ?? "38381");
const clientState = randomBytes(24).toString("base64url");
const returnUri = `http://${callbackHost}:${callbackPort}/auth/callback`;
const loginUrl = new URL("/auth/login", serverBaseUrl);
loginUrl.searchParams.set("return_uri", returnUri);
loginUrl.searchParams.set("client_state", clientState);

const ticket = await waitForAuthTicket(loginUrl.toString());
const session = await redeemTicket(ticket);
console.log(`redeemed WorkOS session for user=${session.user?.email ?? session.user?.id ?? "unknown"}`);

const client = new SecureClient({
  attestationBundleURL: serverBaseUrl,
  baseURL: serverBaseUrl,
});

console.log("verifying Tinfoil attestation and preparing encrypted transport...");
await client.ready();

const requestId = randomUUID();
const response = await client.fetch("/v1/chat/completions", {
  body: JSON.stringify({
    messages: [
      {
        content: "Reply with exactly: ambient-ok",
        role: "user",
      },
    ],
    model: process.env.AMBIENT_E2E_MODEL ?? "gpt-oss-120b",
    temperature: 0,
  }),
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${session.sessionToken}`,
    "Content-Type": "application/json",
    "X-Ambient-App-Version": "e2e-local",
    "X-Ambient-Feature": "inference.chatCompletions",
    "X-Ambient-Request-Id": requestId,
  },
  method: "POST",
});

const body = await response.text();
console.log(JSON.stringify({
  bodyPreview: body.slice(0, 1000),
  requestId,
  status: response.status,
}, null, 2));

if (!response.ok) {
  process.exitCode = 1;
} else if (!body.toLowerCase().includes("ambient-ok")) {
  console.error("LLM response did not contain ambient-ok");
  process.exitCode = 1;
}

function loadEnvFile(url) {
  const text = readFileSync(url, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

async function waitForAuthTicket(authUrl) {
  let resolveTicket;
  let rejectTicket;
  const ticketPromise = new Promise((resolve, reject) => {
    resolveTicket = resolve;
    rejectTicket = reject;
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", returnUri);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("not found");
        return;
      }

      const returnedState = url.searchParams.get("client_state");
      if (returnedState !== clientState) {
        throw new Error("auth callback state mismatch");
      }

      const error = url.searchParams.get("error");
      if (error) {
        throw new Error(`${error}: ${url.searchParams.get("error_description") ?? ""}`.trim());
      }

      const ticket = url.searchParams.get("ticket");
      if (!ticket) {
        throw new Error("auth callback did not include a ticket");
      }

      response.writeHead(200, { "content-type": "text/plain" }).end("Ambient E2E auth complete. You can close this tab.");
      resolveTicket(ticket);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
      rejectTicket(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, callbackHost, resolve);
  });

  console.log(`auth callback listening on ${returnUri}`);
  console.log(`open this login URL if the browser did not open automatically:\n${authUrl}`);
  if (process.env.AMBIENT_E2E_OPEN_BROWSER !== "0") {
    execFile("open", [authUrl], (error) => {
      if (error) console.error(`could not open browser automatically: ${error.message}`);
    });
  }

  try {
    return await ticketPromise;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function redeemTicket(ticket) {
  const response = await fetch(new URL("/auth/redeem", serverBaseUrl), {
    body: JSON.stringify({ ticket }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`ticket redeem failed: ${typeof body.error === "string" ? body.error : response.status}`);
  }
  if (!body.sessionToken) {
    throw new Error("ticket redeem response did not include a session token");
  }
  return body;
}

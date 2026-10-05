import * as audio from "../electron/inference/audio-transcription.js";
import assert from "node:assert/strict";
import { afterAll, it, vi } from "vitest";
import { Effect } from "effect";
import * as inference from "../electron/inference/effect.js";
import * as routing from "../electron/cloud/node-assignment.js";
import * as requestMode from "../electron/inference/request-mode.js";
import * as registry from "../electron/inference/request-registry.js";
import * as network from "../electron/inference/network-log.js";
import * as availability from "../electron/inference/availability.js";
import * as errors from "../electron/inference/errors.js";
import * as sessionModule from "../electron/workos/session.js";
import * as auditModule from "../electron/diagnostics/audit.js";
import * as ownedStream from "../electron/inference/owned-stream.js";
import * as streaming from "../electron/proxy/streaming.js";
import * as messages from "../electron/error-message.js";
import type { IpcStream } from "../electron/ipc-server/socket.js";
import type { SignedInWorkOsSession } from "../electron/workos/session.js";
import { createMainInferenceHarness, type MainInferenceHarness } from "./helpers/main-inference.js";

// Runs before module imports. All Cloud and SDK fetches use explicit in-memory
// fixtures; accidentally choosing a default network path must fail closed.
const originalFetch = vi.hoisted(() => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Uncontrolled inference fixture fetch"); };
  return original;
});
afterAll(() => { globalThis.fetch = originalFetch; });
const forbid = (name: string) => (..._args: unknown[]): never => { throw new Error(`Forbidden fixture operation: ${name}`); };

function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function session(account: string): SignedInWorkOsSession {
  return {kind: 'signed_in', sessionToken: `synthetic-workos-${account}`, email: `${account}@fixture.invalid`,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    user: {id: `user_${account}`, email: `${account}@fixture.invalid`, name: null}};
}
function bootstrap(account: string) {
  const workspaceId = `workspace_${account}`, installationId = `installation_${account}`;
  const apiBaseUrl = `https://node-${account}.fixture.invalid`, userId = `user_${account}`;
  const nowSeconds = Math.floor(Date.now() / 1000), expiry = nowSeconds + 3600;
  const entitlements = {inference: true, multiplayer: false, publishing: false, mcp: false};
  const billing = {mode: 'user_metered', billingAccountId: userId, perUserAllowanceMicros: null,
    perUserHardLimitMicros: null, overage: 'deny', pricingVersion: 'fixture-prices@1'};
  return {version: 'alexandria-cloud-bootstrap/1', status: 'ready',
    workspace: {id: workspaceId, kind: 'personal', workosOrganizationId: null, status: 'active'},
    node: {assignmentId: `assignment_${account}`, installationId, apiBaseUrl, audience: apiBaseUrl,
      capabilities: ['inference'], inferenceMode: 'confidential', configurationVersion: 7},
    entitlements: {workspaceId, ...entitlements}, billing: {workspaceId, ...billing},
    identity: {tokenType: 'Bearer', accessToken: `synthetic-node-identity-${account}`,
      expiresAt: new Date(expiry * 1000).toISOString(), rotatedSessionToken: null,
      claims: {iss: 'https://cloud.fixture.invalid', aud: apiBaseUrl, sub: userId, workspaceId,
        workspaceKind: 'personal', workosOrganizationId: null, installationId, sessionEpoch: 0,
        entitlements, billing, iat: nowSeconds, exp: expiry}}};
}
function fixture() {
  const events: Array<{name: string; [key: string]: unknown}> = [], pending = deferred<Response>(), started = deferred<void>();
  const bodyRead = deferred<void>(), responseStarted = deferred<void>();
  const readyStarted = deferred<void>(), invalidateStarted = deferred<void>();
  let readyGate: Promise<void> | undefined, invalidateGate: Promise<void> | undefined;
  const stopped = deferred<never>(), lifetime = new AbortController();
  void stopped.promise.catch(() => {});
  const wait = <T>(promise: Promise<T>): Promise<T> => {
    lifetime.signal.throwIfAborted();
    return Promise.race([promise, stopped.promise]);
  };
  const drains: Promise<unknown>[] = [];
  let cancelBody = () => {};
  void pending.promise.catch(() => {});
  let stored = session('a'), signal: AbortSignal | undefined, runtime: MainInferenceHarness;
  const audit = new auditModule.MemoryAuditSink();
  const activeInferenceRequests = new registry.InferenceRequestRegistry();
  const networkHistory = new network.NetworkRequestHistory();
  const inferenceAvailability = new availability.InferenceAvailabilityCircuit();
  const cloudNodeRouting = routing.createCloudNodeRoutingService({
    cloudBaseUrl: 'https://cloud.fixture.invalid', legacyMultiplayerBaseUrl: null,
    fetchImpl: async (url, init) => {
      assert.ok(init);
      assert.equal(url, 'https://cloud.fixture.invalid/v1/bootstrap'); assert.equal(init.method, 'POST');
      const token = new Headers(init.headers).get('authorization');
      const account = token === 'Bearer synthetic-workos-a' ? 'a'
        : token === 'Bearer synthetic-workos-b' ? 'b' : null;
      assert.ok(account, 'unexpected bootstrap identity');
      events.push({name: 'bootstrap', account});
      return Response.json(bootstrap(account));
    },
    onStateChange: (snapshot) => events.push({name: 'route', snapshot: structuredClone(snapshot)}),
    onRotatedSessionToken: forbid('Cloud token rotation'),
  });
  const clearOnly = (name: string) => ({clear: () => events.push({name: `${name}-clear`}), observe: forbid(`${name}-observe`)});
  const sentinelClient = {ready: forbid('legacy ready'), fetch: forbid('legacy fetch')};
  const deps = {
    Effect, ...audio, ...inference, ...routing, ...requestMode, ...registry, ...network, ...errors, ...ownedStream, ...streaming, ...messages,
    shouldRefreshWorkOsSession: sessionModule.shouldRefreshWorkOsSession,
    activeInferenceRequests, networkHistory, inferenceAvailability, sessionUsageOwnerKey: availability.sessionUsageOwnerKey,
    inferenceAccessBlockReason: availability.inferenceAccessBlockReason,
    cloudNodeRouting: {...cloudNodeRouting, invalidate: () => Effect.gen(function* () {
      if (invalidateGate) { invalidateStarted.resolve(); yield* Effect.promise(() => invalidateGate!); }
      yield* cloudNodeRouting.invalidate();
    })},
    createBridgeSecureClient: (input: {serverBaseUrl: string}) => inference.createBridgeSecureClient({...input,
      makeSecureClient: (options) => {
        assert.equal(options.baseURL, 'https://node-a.fixture.invalid');
        assert.equal(options.attestationBundleURL, options.baseURL);
        return {ready: async () => { events.push({name: 'client-ready'}); readyStarted.resolve(); if (readyGate) await readyGate; }, fetch: async (url, init) => {
          assert.ok(init);
          assert.equal(url, '/v1/responses'); assert.equal(init.method, 'POST');
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-node-identity-a');
          assert.equal(new Headers(init.headers).get('x-alexandria-inference-mode'), 'confidential');
          signal = init.signal!; events.push({name: 'a-fetch-start'}); started.resolve();
          return pending.promise;
        }};
      }}),
    bridgeSecureClient: sentinelClient, bridgePlaintextClient: sentinelClient,
    createBridgePlaintextClient: forbid('plaintext client'),
    sessionStore: () => ({read: async () => structuredClone(stored), write: forbid('session write'), clear: forbid('session clear')}),
    refreshStoredSessionDirect: forbid('WorkOS refresh'), storeRotatedSessionToken: forbid('response token rotation'),
    bridgeUsageService: {reserve: forbid('legacy reserve'), release: forbid('legacy release')},
    bridgeUsageCache: clearOnly('usage'), bridgeModelAssignmentCache: clearOnly('models'), bridgeInferencePlanCache: clearOnly('plan'), bridgeOrgPolicyCache: clearOnly('org-policy'),
    bridgePricingCache: clearOnly('pricing'), wireTap: clearOnly('wire'),
    audit, bridgeAuditService: inference.createBridgeAuditService(audit),
    publishRequestLogUpserts: (records: network.NetworkRequestRecord[]) => events.push({name: 'upsert', records: structuredClone(records)}),
    publishRequestLogReset: () => events.push({name: 'reset'}),
    notifyStatusChanged: () => events.push({name: 'notify'}),
    refreshInferenceUsageCircuit: async () => { events.push({name: 'usage-refresh'}); },
    app: {getVersion: () => 'fixture-only', isPackaged: true},
    serverBaseUrl: 'https://cloud.fixture.invalid',
    console: {error: (...fields: unknown[]) => events.push({name: 'console-error', fields})},
  };
  runtime = createMainInferenceHarness(deps);
  const start = () => {
    lifetime.signal.throwIfAborted();
    return runtime.forwardInference({type: 'request', id: 'request-1', method: 'inference.responses',
      payload: {model: 'fixture-model', input: 'synthetic fixture'}}, {credentialId: 'fixture-client', readBinaryUpload: forbid('binary upload')}, '/v1/responses');
  };
  const snapshot = () => Effect.runSync(cloudNodeRouting.snapshot());
  const switchAccount = async () => {
    lifetime.signal.throwIfAborted();
    stored = session('b'); events.push({name: 'switch-to-b'}); runtime.clearInferenceTransparency();
    assert.equal(runtime.readState().generation, 1); assert.equal(signal?.aborted, true);
    assert.equal(activeInferenceRequests.size, 0); assert.deepEqual(networkHistory.list(), []);
    assert.equal(snapshot().state, 'unknown');
    await wait(Effect.runPromise(cloudNodeRouting.resolve(stored)));
    assert.equal(snapshot().state, 'ready'); assert.equal(snapshot().origin, 'https://node-b.fixture.invalid');
    events.push({name: 'b-ready'});
    return structuredClone(snapshot());
  };
  return {events, pending, started, bodyRead, responseStarted, drains, wait, start, snapshot, switchAccount, runtime, activeInferenceRequests,
    networkHistory, audit, stored: () => structuredClone(stored), signal: () => signal,
    setReadyGate: (gate: Promise<void>) => {readyGate=gate; return readyStarted.promise;},
    setInvalidateGate: (gate: Promise<void>) => {invalidateGate=gate; return invalidateStarted.promise;},
    setBodyCleanup: (cleanup: () => void) => { cancelBody = cleanup; },
    close: async (test: Promise<void>) => {
      const reason = new DOMException('fixture cleanup', 'AbortError');
      lifetime.abort(reason);
      stopped.reject(reason);
      pending.reject(reason);
      cancelBody();
      activeInferenceRequests.abortAll();
      await bounded(Promise.allSettled([test, ...drains]), 1000, 'Inference fixture cleanup did not settle');
      assert.equal(activeInferenceRequests.size, 0);
    }};
}
function check(name: string, test: (f: ReturnType<typeof fixture>) => Promise<void>) {
  it(name, async () => {
    const f = fixture();
    const task = test(f);
    try {
      await bounded(task, 2000, 'Inference fixture stalled');
    } finally {
      await f.close(task);
    }
  });
}
type Outcome = {value?: Awaited<ReturnType<typeof drain>>; error?: Error & {code?: string}};
const observe = (promise: Promise<Awaited<ReturnType<typeof drain>>>): Promise<Outcome> => promise.then(value => ({value}), error => ({error}));
async function drain(stream: IpcStream, onStart: () => void) {
  const chunks = [];
  for await (const chunk of stream) {
    assert.ok(chunk && typeof chunk === 'object' && !Array.isArray(chunk));
    chunks.push(chunk);
    if (chunk.kind === 'openai.response.start') onStart();
  }
  return chunks;
}
async function begin(f: ReturnType<typeof fixture>) {
  const result = observe(drain(f.start(), () => f.responseStarted.resolve()));
  f.drains.push(result);
  await f.wait(Promise.race([f.started.promise, result.then(() => {throw new Error('Request finished before reaching controlled fetch');})]));
  assert.equal(f.activeInferenceRequests.size, 1); assert.equal(f.snapshot().state, 'ready');
  return {result};
}
function noStalePublication(f: ReturnType<typeof fixture>, expected: routing.CloudNodeRoutingSnapshot) {
  assert.equal(f.activeInferenceRequests.size, 0);
  assert.deepEqual(f.networkHistory.list(), []);
  assert.equal(f.stored().user.id, 'user_b');
  assert.equal(f.runtime.readState().status.lastError, null);
  const after = f.events.slice(f.events.findIndex(event => event.name === 'b-ready') + 1);
  assert.equal(after.some(event => ['upsert', 'usage-refresh', 'notify'].includes(event.name)), false);
  assert.deepEqual(f.snapshot(), expected, 'new account B route must survive old request completion');
}

check('stale pre-header AbortError preserves new account route', async f => {
  const {result} = await begin(f), expected = await f.switchAccount();
  f.events.push({name: 'a-reject'}); f.pending.reject(new DOMException('old request aborted', 'AbortError'));
  assert.deepEqual(await result, {value: []});
  noStalePublication(f, expected);
});
check('same-generation HTTP401 invalidates Node identity', async f => {
  const {result} = await begin(f);
  f.pending.resolve(Response.json({error: {code: 'authentication_required', message: 'synthetic expired Node identity'}}, {status: 401}));
  const outcome = await result; assert.equal(outcome.error?.code, 'authentication_required');
  assert.equal(f.snapshot().state, 'unknown'); assert.equal(f.stored().user.id, 'user_a');
  assert.equal(f.activeInferenceRequests.size, 0); assert.equal(f.networkHistory.latest()?.status, 'failed');
});
check('same-generation HTTP429 preserves route', async f => {
  const {result} = await begin(f), expected = f.snapshot();
  f.pending.resolve(Response.json({error: {code: 'capacity_exhausted', message: 'synthetic capacity'}}, {status: 429}));
  assert.equal((await result).error?.code, 'capacity_exhausted'); assert.deepEqual(f.snapshot(), expected);
  assert.equal(f.activeInferenceRequests.size, 0);
});
check('same-generation fetch failure invalidates route', async f => {
  const {result} = await begin(f); f.pending.reject(new TypeError('synthetic transport failure'));
  const outcome = await result;
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /synthetic transport failure/);
  assert.equal(f.snapshot().state, 'unknown'); assert.equal(f.activeInferenceRequests.size, 0);
});
check('current successful stream completes and releases request', async f => {
  const {result} = await begin(f), expected = f.snapshot();
  f.pending.resolve(new Response('data: synthetic\n\n', {headers: {'content-type': 'text/event-stream'}}));
  const outcome = await result; assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value!.map((chunk: {kind?: unknown}) => chunk.kind), ['openai.response.start', 'openai.response.chunk']);
  assert.equal(outcome.value![1].data, 'data: synthetic\n\n'); assert.deepEqual(f.snapshot(), expected);
  assert.equal(f.activeInferenceRequests.size, 0); assert.equal(f.networkHistory.latest()?.status, 'completed');
});
check('stale successful response preserves new account route', async f => {
  const {result} = await begin(f), expected = await f.switchAccount();
  f.pending.resolve(new Response('old response')); assert.deepEqual(await result, {value: []});
  noStalePublication(f, expected);
});
check('stale body-stream failure preserves new account route', async f => {
  const {result} = await begin(f); let controller!: ReadableStreamDefaultController;
  f.pending.resolve(new Response(new ReadableStream({start(c) {controller = c;}, pull() {f.bodyRead.resolve();}}, {highWaterMark: 0})));
  f.setBodyCleanup(() => { try {controller.error(new Error('fixture body cleanup'));} catch { /* Already settled. */ } });
  await f.wait(Promise.race([
    Promise.all([f.bodyRead.promise, f.responseStarted.promise]),
    result.then(() => { throw new Error('Response ended before the body phase'); }),
  ]));
  const expected = await f.switchAccount(); controller.error(new Error('synthetic old body failure'));
  const outcome = await result; assert.equal(outcome.error, undefined);
  assert.equal(outcome.value![0]?.kind, 'openai.response.start'); noStalePublication(f, expected);
});
check('old finally preserves replacement registry owner', async f => {
  const {result} = await begin(f); await f.switchAccount();
  const replacement = new AbortController();
  f.activeInferenceRequests.register({credentialId: 'fixture-client', requestId: 'request-1', controller: replacement});
  f.pending.reject(new DOMException('old request aborted', 'AbortError')); await result;
  assert.equal(f.activeInferenceRequests.size, 1); assert.equal(replacement.signal.aborted, false);
  f.activeInferenceRequests.release('fixture-client', 'request-1', replacement);
});

check('same-generation client cancellation keeps existing route recovery', async f => {
  const {result} = await begin(f);
  assert.equal(f.activeInferenceRequests.cancel('fixture-client', 'request-1'), true);
  f.pending.reject(new DOMException('client canceled', 'AbortError'));
  assert.deepEqual(await result, {value: []});
  assert.equal(f.snapshot().state, 'unknown');
  assert.equal(f.networkHistory.latest()?.status, 'cancelled');
});

async function beginWithTrailer(f: ReturnType<typeof fixture>) {
  const {result} = await begin(f), trailer = deferred<Headers>(), read = deferred<void>();
  void trailer.promise.catch(() => {});
  f.setBodyCleanup(() => trailer.reject(new Error('fixture trailer cleanup')));
  const response = new Response('data: synthetic\n\n', {headers: {'content-type': 'text/event-stream'}});
  Object.defineProperty(response, 'trailer', {get() {read.resolve(); return trailer.promise;}});
  f.pending.resolve(response);
  await f.wait(Promise.race([
    read.promise,
    result.then(() => {throw new Error('Response ended before trailer read');}),
  ]));
  return {result, trailer};
}
const trailerUsage = () => new Headers({'x-tinfoil-usage-metrics': 'prompt=5,completion=7,total=12'});
const trailerOutcome = {value: [
  {contentType: 'text/event-stream', kind: 'openai.response.start', status: 200},
  {data: 'data: synthetic\n\n', kind: 'openai.response.chunk'},
]};

for (const ending of ['usage', 'empty', 'rejected'] as const) {
  check(`retired trailer ${ending} cannot publish or refresh replacement account`, async f => {
    const {result, trailer} = await beginWithTrailer(f), expected = await f.switchAccount();
    if (ending === 'rejected') trailer.reject(new Error('synthetic trailer error'));
    else trailer.resolve(ending === 'usage' ? trailerUsage() : new Headers());
    assert.deepEqual(await result, trailerOutcome);
    noStalePublication(f, expected);
  });
}

check('retired trailer cannot overwrite an admitted replacement with the same request key', async f => {
  const {result, trailer} = await beginWithTrailer(f), expected = await f.switchAccount();
  // Admission is real forwardInference; the replacement transport is not drained.
  const replacement = f.start()[Symbol.asyncIterator]();
  try {
    const history = f.networkHistory.list(), marker = f.events.length;
    assert.equal(history.length, 1); assert.equal(history[0]!.usage, null);
    trailer.resolve(trailerUsage()); assert.deepEqual(await result, trailerOutcome);
    assert.deepEqual(f.networkHistory.list(), history);
    assert.equal(f.activeInferenceRequests.size, 1);
    assert.deepEqual(f.snapshot(), expected);
    assert.equal(f.events.slice(marker).some(event => ['upsert', 'usage-refresh', 'notify'].includes(event.name)), false);
  } finally {
    await replacement.return?.();
    f.activeInferenceRequests.abortAll('fixture replacement disposal');
  }
});

check('current trailer preserves usage completion and refresh', async f => {
  const {result, trailer} = await beginWithTrailer(f), expected = f.snapshot();
  trailer.resolve(trailerUsage()); assert.deepEqual(await result, trailerOutcome);
  assert.deepEqual(f.networkHistory.latest()?.usage, {promptTokens: 5, completionTokens: 7, totalTokens: 12});
  assert.equal(f.networkHistory.latest()?.status, 'completed');
  assert.equal(f.events.filter(event => event.name === 'usage-refresh').length, 1);
  assert.equal(f.activeInferenceRequests.size, 0); assert.deepEqual(f.snapshot(), expected);
});

check('same-generation cancellation during trailer wait retains existing completion policy', async f => {
  const {result, trailer} = await beginWithTrailer(f), expected = f.snapshot();
  assert.equal(f.activeInferenceRequests.cancel('fixture-client', 'request-1'), true);
  trailer.resolve(trailerUsage()); assert.deepEqual(await result, trailerOutcome);
  assert.deepEqual(f.networkHistory.latest()?.usage, {promptTokens: 5, completionTokens: 7, totalTokens: 12});
  assert.equal(f.networkHistory.latest()?.status, 'completed');
  assert.equal(f.events.filter(event => event.name === 'usage-refresh').length, 1);
  assert.equal(f.activeInferenceRequests.size, 0); assert.deepEqual(f.snapshot(), expected);
});

check('invalid audio metadata never admits an inference request', async f => {
  assert.throws(() => f.runtime.forwardAudioTranscription({
    type: 'request', id: 'invalid-audio', method: 'inference.audioTranscriptions', payload: {},
  }, { credentialId: 'fixture-client', readBinaryUpload: forbid('invalid audio read') }), /audioByteLength/);
  assert.equal(f.activeInferenceRequests.size, 0);
  assert.deepEqual(f.networkHistory.list(), []);
});

check('audio cancellation reaches upload preparation before any network request', async f => {
  let uploadSignal: AbortSignal | undefined;
  const stream = f.runtime.forwardAudioTranscription({
    type: 'request', id: 'cancel-audio', method: 'inference.audioTranscriptions',
    payload: {audioByteLength: 7, audioSha256: 'a'.repeat(64)},
  }, {
    credentialId: 'fixture-client',
    readBinaryUpload: options => {
      assert.equal(options?.expectedByteLength, 7);
      assert.equal(options?.maxBytes, 7);
      assert.equal(options?.expectedSha256, 'a'.repeat(64));
      uploadSignal = options?.signal;
      assert.ok(uploadSignal, 'upload must receive its owning inference signal');
      const signal = uploadSignal;
      return new Promise<Buffer>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    },
  });
  const result = observe(drain(stream, forbid('cancelled audio response')));
  f.drains.push(result);
  assert.equal(f.activeInferenceRequests.cancel('fixture-client', 'cancel-audio'), true);
  assert.equal(uploadSignal?.reason, 'client_cancelled');
  assert.deepEqual(await result, {value: []});
  assert.equal(f.networkHistory.latest()?.status, 'cancelled');
  assert.equal(f.events.some(event => event.name === 'bootstrap' || event.name === 'a-fetch-start'), false);
});

check('disposing an unstarted inference releases admission without fetching', async f => {
  const iterator = f.start()[Symbol.asyncIterator]();
  assert.equal(f.activeInferenceRequests.size, 1);
  await iterator.return?.();
  assert.equal(f.activeInferenceRequests.size, 0);
  assert.equal(f.events.some(event => event.name === 'bootstrap' || event.name === 'a-fetch-start'), false);
  assert.equal(f.networkHistory.latest()?.status, 'cancelled');
});

check('early response consumer return aborts and discards unread body', async f => {
  const iterator = f.start()[Symbol.asyncIterator]();
  const first = iterator.next();
  await f.wait(f.started.promise);
  let cancelled = false;
  const response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
  f.pending.resolve(response);
  assert.equal((await first).value?.kind, 'openai.response.start');
  await iterator.return?.();
  assert.equal(f.signal()?.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
  assert.equal(f.activeInferenceRequests.size, 0);
});

check('consumer return interrupts a blocked response read', async f => {
  const iterator = f.start()[Symbol.asyncIterator]();
  const first = iterator.next();
  await f.wait(f.started.promise);
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() {f.bodyRead.resolve();}, cancel() {cancelled = true;},
  }, {highWaterMark: 0}));
  f.pending.resolve(response); await first;
  const next = iterator.next();
  await f.wait(f.bodyRead.promise);
  await iterator.return?.();
  assert.equal((await next).done, true);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
  assert.equal(f.activeInferenceRequests.size, 0);
});

check('late retired response cancels its unread body', async f => {
  const {result} = await begin(f), expected = await f.switchAccount();
  let cancelled = false;
  const response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
  f.pending.resolve(response); await result;
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
  noStalePublication(f, expected);
});

check('unstarted audio disposal aborts and observes upload rejection', async f => {
  let signal!: AbortSignal;
  const stream = f.runtime.forwardAudioTranscription({type: 'request', id: 'unstarted-audio',
    method: 'inference.audioTranscriptions', payload: {audioByteLength: 7, audioSha256: 'a'.repeat(64)}}, {
    credentialId: 'fixture-client', readBinaryUpload(options) {
      signal = options!.signal!;
      return new Promise<Buffer>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
    },
  });
  await stream[Symbol.asyncIterator]().return?.();
  assert.equal(signal.aborted, true);
  assert.equal(f.activeInferenceRequests.size, 0);
});

check('old consumer cancellation cannot mark a same-key replacement cancelled', async f => {
  const iterator = f.start()[Symbol.asyncIterator]();
  const first = iterator.next(); await f.wait(f.started.promise);
  f.pending.resolve(new Response(new ReadableStream({pull() {f.bodyRead.resolve();}}, {highWaterMark:0})));
  await first;
  const next = iterator.next(); await f.wait(f.bodyRead.promise);
  const closing = iterator.return?.();
  const replacement = f.start()[Symbol.asyncIterator]();
  try {
    await closing; await next;
    assert.equal(f.activeInferenceRequests.size, 1);
    assert.equal(f.networkHistory.latest()?.status, 'active');
  } finally {await replacement.return?.();}
});

check('history eviction does not end an active response', async f => {
  const {result} = await begin(f);
  for (let i=0; i<101; i++) f.networkHistory.start({requestId:`other-${i}`, feature:'fixture', model:null,
    path:'/v1/responses', startedAt:i});
  f.pending.resolve(new Response('remaining bytes'));
  const outcome = await result;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value![1].data, 'remaining bytes');
  assert.equal(f.activeInferenceRequests.size, 0);
});

check('replacement retires attestation ownership before it starts streaming', async f => {
  const gate=deferred<void>(), entered=f.setReadyGate(gate.promise);
  const iterator=f.start()[Symbol.asyncIterator](); const next=iterator.next();
  const observed=next.catch(() => undefined); f.drains.push(observed);
  await f.wait(entered); assert.equal(f.runtime.readState().attestationCount,1);
  const replacement=f.start()[Symbol.asyncIterator]();
  try {
    assert.equal(f.runtime.readState().attestationCount,0);
    gate.resolve(); f.pending.reject(new Error('retired fetch'));
    await observed;
    assert.equal(f.networkHistory.latest()?.status,'active');
  } finally { gate.resolve(); await iterator.return?.(); await replacement.return?.(); }
});

check('ownership is rechecked after route invalidation awaits', async f => {
  const gate=deferred<void>(), entered=f.setInvalidateGate(gate.promise);
  const {result}=await begin(f); f.pending.reject(new Error('old failure'));
  await f.wait(entered);
  const replacement=f.start()[Symbol.asyncIterator]();
  try {
    gate.resolve(); await result;
    assert.equal(f.networkHistory.latest()?.status,'active');
    assert.equal(f.runtime.readState().status.lastError,null);
  } finally {gate.resolve(); await replacement.return?.();}
});

check('history eviction cannot revive a superseded request', async f => {
  const {result}=await begin(f);
  const replacement=f.start()[Symbol.asyncIterator]();
  try {
    for(let i=0;i<101;i++) f.networkHistory.start({requestId:`other-${i}`,feature:'fixture',model:null,
      path:'/v1/responses',startedAt:i});
    f.pending.resolve(new Response('retired bytes'));
    assert.deepEqual(await result,{value:[]});
    assert.equal(f.activeInferenceRequests.size,1);
  } finally {await replacement.return?.();}
});


check('billing errors retain typed evidence and leave the ready Node route intact', async f => {
  const {result} = await begin(f);
  f.pending.resolve(new Response('private provider billing body', {status: 503, headers: {
    'x-ambient-error-code': 'UPSTREAM_BILLING_UNAVAILABLE',
    'x-ambient-error-source': 'openrouter_provider', 'retry-after': '60',
  }}));
  const outcome = await result;
  assert.ok(outcome.error instanceof errors.BridgeInferenceServiceError);
  assert.equal(outcome.error._tag, 'BridgeInferenceServiceError');
  assert.equal(outcome.error.source, 'openrouter_provider');
  assert.equal(f.snapshot().state, 'ready');
  assert.equal(f.networkHistory.latest()?.statusCode, 503);
  assert.match(f.networkHistory.latest()?.error ?? '', /AI processing is temporarily unavailable/);
  const entry = f.audit.recent().find(item => item.name === 'inference.forward_failed');
  assert.equal(entry?.fields.errorCode, 'UPSTREAM_BILLING_UNAVAILABLE');
  assert.equal(entry?.fields.httpStatus, 503);
  assert.equal(entry?.fields.requestId, 'request-1');
  assert.equal(typeof entry?.at, 'number');
  assert.ok(!JSON.stringify(f.audit.recent()).includes('private provider billing body'));
});

check('a globally disabled grant refusal keeps the route, trips nothing and shows the readable text (ADR-0296)', async f => {
  const {result} = await begin(f);
  f.pending.resolve(Response.json(
    {error: {code: 'policy_denied', message: 'globally_disabled: Claude is temporarily unavailable.'}},
    {status: 403},
  ));
  const outcome = await result;
  const error = outcome.error as {code?: string; message?: string} | undefined;
  assert.equal(error?.code, 'policy_denied');
  assert.equal(error?.message, 'globally_disabled: Claude is temporarily unavailable.');
  assert.equal(f.snapshot().state, 'ready');
  assert.equal(f.networkHistory.latest()?.error, 'Claude is temporarily unavailable.');
  assert.equal(f.runtime.readState().status.lastError, 'Claude is temporarily unavailable.');
});

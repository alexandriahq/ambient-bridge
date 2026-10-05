import { readFileSync } from "node:fs";
import ts from "typescript";
import type { BridgeRequestFrame } from "../../electron/ipc-server/protocol.js";
import type { IpcHandlerContext, IpcStream } from "../../electron/ipc-server/socket.js";
import type { InferenceProxyPath } from "../../electron/inference/effect.js";

// Main boots Electron and installs filesystem/network hooks on import. Execute
// complete current declarations at this narrow seam without booting the app.
// Environmental bindings are supplied explicitly; no function body is rewritten.
const names = [
  'inferenceAdmissions', 'admitInferenceStream', 'forwardAudioTranscription', 'prepareAudioTranscriptionRequest', 'forwardInference', 'jsonPayloadByteLength', 'authenticatedCredentialId',
  'inferenceResponseStream', 'clearInferenceTransparency', 'readSignedInSession',
  'refreshInferenceSessionIfNeeded', 'resolveInferenceNodeRoute',
  'nodeSecureClient', 'initialInferenceStatus', 'startInferenceStatus', 'updateInferenceRequest',
  'completeInferenceStatus', 'failInferenceStatus', 'beginInferenceAttestationCheck',
  'completeInferenceAttestationCheck', 'failInferenceAttestationCheck', 'recentAttestationChecks',
  'secureClientWithAttestationStatus', 'payloadString', 'publicOrigin', 'safeStatusMessage',
  'inferenceHttpError', 'isProviderInferenceError', 'ProviderInferenceError', 'accessBlockReason',
  'PUBLIC_INFERENCE_ERROR_CODES', 'ATTESTATION_HISTORY_LIMIT',
];
const bindings = [
  'Effect', 'BridgeSessionService', 'BridgeSecureClient', 'BridgeAuditService',
  'secureInferenceResponse', 'createBridgeSessionService', 'createCloudNodeSecureClient',
  'createBridgeSecureClient', 'cloudNodeRouting', 'inferenceRouteFromAssignment',
  'inferenceClientForMode', 'nodeModeForRequest', 'assertInferencePathAllowedInMode',
  'requestInferenceModeFromPayload', 'shouldRefreshWorkOsSession',
  'inferenceRequestKey', 'sessionUsageOwnerKey', 'inferenceAccessBlockReason', 'activeInferenceRequests', 'networkHistory', 'inferenceAvailability',
  'ownedInferenceStream', 'discardResponseBody', 'streamResponseBody', 'readEhbpResponseEvidence', 'readEhbpUsageAfterBody', 'inferenceDomainError',
  'BridgeInsufficientCreditError', 'BridgeGloballyDisabledError', 'globallyDisabledRefusalText', 'errorMessage', 'bridgeSecureClient',
  'createBridgePlaintextClient', 'sessionStore', 'refreshStoredSessionDirect',
  'storeRotatedSessionToken', 'bridgeUsageService', 'bridgeUsageCache', 'bridgeModelAssignmentCache', 'bridgeInferencePlanCache', 'bridgeOrgPolicyCache',
  'bridgePricingCache', 'wireTap', 'audit', 'bridgeAuditService', 'publishRequestLogUpserts',
  'publishRequestLogReset', 'notifyStatusChanged', 'refreshInferenceUsageCircuit',
  'app', 'serverBaseUrl', 'console',
  'audioUploadMetadataFromPayload', 'audioTranscriptionRequestFromPayload',
];

export interface MainInferenceHarness {
  forwardInference(frame: BridgeRequestFrame, context: IpcHandlerContext, path: InferenceProxyPath): IpcStream;
  forwardAudioTranscription(frame: BridgeRequestFrame, context: IpcHandlerContext): IpcStream;
  clearInferenceTransparency(): void;
  readState(): { generation: number; status: { lastError: string | null }; attestationCount: number };
}

const original = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("main.ts", original, ts.ScriptTarget.Latest, true);
const declarations = names.map(name => {
  const matches = source.statements.filter(node =>
    ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
      && node.declarationList.declarations[0].name.getText(source) === name));
  if (matches.length !== 1) throw new Error(`Expected one complete main declaration: ${name}`);
  return original.slice(matches[0]!.getStart(source), matches[0]!.getEnd());
});
const emitted = ts.transpileModule(
  `const {${bindings.join(",")}} = deps;\n${declarations.join("\n\n")}`
  + "\nlet inferenceGeneration = 0; const activeAttestationChecks = new Set();"
  + "\nconst nodeSecureClients = new Map(); let inferenceStatus = initialInferenceStatus();"
  + "\nreturn {forwardInference, forwardAudioTranscription, clearInferenceTransparency, readState: () => ({"
  + "generation: inferenceGeneration, status: structuredClone(inferenceStatus),"
  + "attestationCount: activeAttestationChecks.size})};",
  { compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true },
);
const failures = emitted.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
if (failures.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(failures, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => ".", getNewLine: () => "\n",
}));
const create = new Function("deps", '"use strict";\n' + emitted.outputText) as (deps: Record<string, unknown>) => MainInferenceHarness;

export function createMainInferenceHarness(deps: Record<string, unknown>): MainInferenceHarness {
  for (const binding of bindings) {
    if (!(binding in deps)) throw new Error(`Missing main inference binding: ${binding}`);
  }
  return create(deps);
}

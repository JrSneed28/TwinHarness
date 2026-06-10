/**
 * `llm-client` seam — the bounded-backoff retry policy that wraps the Anthropic
 * Messages API transport (IF-006, REQ-NFR-004, ADR-007/ADR-008).
 *
 * The retry policy lives BEHIND the seam (ARCH-RISK-001/004 confinement): the
 * agent-run loop sees only a resolved `LlmResponse` or a thrown `LlmFatalError`.
 *
 * Policy (concrete — IF-006 / technical-design §LlmClient):
 *  - Transient (retried): HTTP 429 / 500 / 502 / 503 / 529, network timeout,
 *    socket/connection reset → retry, exponential backoff base 1000ms cap
 *    30000ms + FULL JITTER, honoring `Retry-After` as a FLOOR.
 *  - Fatal (NOT retried → LLM_FATAL): HTTP 401/403 (bad/expired key), HTTP 400
 *    (malformed), any non-transient 4xx.
 *  - At most 5 SDK calls total (1 initial + 4 retries). Retry exhaustion → fatal.
 *  - Each retry emits an `llm-retry` TranscriptEntry { attempt, errorClass, delayMs }.
 *
 * The REAL SDK transport body is SEAM-EXCLUDED (out of scope this slice): the
 * policy wraps an injected `transport` function. Tests inject a transport that
 * throws scripted transient/fatal errors. A thin real wrapper (createSdkTransport)
 * is provided for completeness — it reads Config.modelId and is NOT required by
 * any test.
 */
import type {
  ConversationMessage,
  LlmClient,
  LlmResponse,
  ToolSchema,
} from "./contracts.js";
import { LlmFatalError } from "./tool-errors.js";

/** Backoff constants (IF-006). */
export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 30000;
/** Max SDK calls = 1 initial + 4 retries (IF-006 postcondition). */
export const MAX_ATTEMPTS = 5;

/**
 * A transport-layer error the policy can classify. The real SDK errors are
 * mapped onto this shape by the (seam-excluded) transport wrapper; tests throw
 * it directly. `status` is the HTTP status (when applicable); `kind` covers the
 * non-HTTP transient cases (timeout, socket reset).
 */
export interface TransportError {
  /** HTTP status code, when the failure carried one. */
  status?: number;
  /** Non-HTTP transient kind: a network timeout or a connection/socket reset. */
  kind?: "timeout" | "socket_reset";
  /** `Retry-After` header value in SECONDS (429/529), when present. */
  retryAfterSeconds?: number;
  /** Human-readable detail for diagnostics / the thrown LLM_FATAL message. */
  message?: string;
}

/** Type guard: a thrown value that looks like a TransportError. */
function asTransportError(err: unknown): TransportError | null {
  if (err && typeof err === "object" && ("status" in err || "kind" in err)) {
    return err as TransportError;
  }
  return null;
}

/** Transient HTTP statuses that are retried (IF-006). */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 529]);

/**
 * Classify a TransportError. Returns:
 *  - "transient" → retry (within the attempt budget),
 *  - "fatal"     → throw LLM_FATAL immediately, no retry.
 * Anything not explicitly transient (incl. 401/403/400 and all other 4xx) is
 * fatal — the policy is precise about NOT retrying non-transient 4xx.
 */
export function classifyTransport(te: TransportError): {
  retryable: boolean;
  errorClass: string;
} {
  if (te.kind === "timeout") return { retryable: true, errorClass: "network_timeout" };
  if (te.kind === "socket_reset") return { retryable: true, errorClass: "socket_reset" };
  if (typeof te.status === "number") {
    if (TRANSIENT_STATUSES.has(te.status)) {
      return { retryable: true, errorClass: `http_${te.status}` };
    }
    return { retryable: false, errorClass: `http_${te.status}` };
  }
  // Unknown/unclassifiable transport failure → treat as fatal (do not hang).
  return { retryable: false, errorClass: "unknown_transport_error" };
}

/**
 * Compute the backoff delay for `attempt` (1-based). Exponential
 * `base * 2^(attempt-1)`, capped at `cap`, with FULL JITTER applied as
 * `floor(rawDelay * random01)` (random in [0,1)). When `retryAfterMs` is present
 * it FLOORS the result: the final delay is `max(jittered, retryAfterMs)`.
 *
 * `random01` is injected so backoff is deterministic in tests.
 */
export function computeBackoffMs(
  attempt: number,
  random01: number,
  retryAfterMs?: number,
): number {
  const raw = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  // Full jitter: sleep is random(0, raw).
  const clamped = random01 < 0 ? 0 : random01 >= 1 ? 0.9999999 : random01;
  const jittered = Math.floor(raw * clamped);
  if (typeof retryAfterMs === "number" && retryAfterMs > jittered) {
    return retryAfterMs;
  }
  return jittered;
}

/** The injected transport — the seam-excluded real SDK call (or a test stub). */
export type LlmTransport = (
  conversation: ConversationMessage[],
  toolSchemas: ToolSchema[],
) => Promise<LlmResponse>;

export interface LlmClientDeps {
  /** The transport to wrap (real SDK call in prod; scripted stub in tests). */
  transport: LlmTransport;
  /**
   * Emit an `llm-retry` TranscriptEntry-shaped record per retry. Injected so the
   * seam stays decoupled from the writer; agent-run wires this to the transcript.
   */
  onRetry?: (entry: { attempt: number; errorClass: string; delayMs: number }) => void;
  /** Injected jitter source in [0,1); defaults to Math.random (deterministic in tests). */
  random01?: () => number;
  /** Injected delay; defaults to real setTimeout. Tests pass a no-op to stay fast. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Construct the retrying LlmClient. `send` performs at most MAX_ATTEMPTS calls to
 * the transport; transient failures retry with bounded backoff + full jitter
 * (Retry-After flooring); non-transient failures and exhaustion throw
 * `LlmFatalError` (LLM_FATAL).
 */
export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const random01 = deps.random01 ?? Math.random;
  const sleep = deps.sleep ?? realSleep;

  return {
    async send(
      conversation: ConversationMessage[],
      toolSchemas: ToolSchema[],
    ): Promise<LlmResponse> {
      let lastErrorClass = "unknown";
      // attempt is 1-based; up to MAX_ATTEMPTS total transport calls.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await deps.transport(conversation, toolSchemas);
        } catch (err) {
          const te = asTransportError(err);
          if (te === null) {
            // A non-transport throw (a harness bug) is fatal — never swallow.
            throw new LlmFatalError(
              `LLM_FATAL: unexpected transport failure: ${(err as Error).message}`,
              "unexpected",
            );
          }
          const { retryable, errorClass } = classifyTransport(te);
          lastErrorClass = errorClass;

          // Non-transient → immediate fatal, no retry (401/403/400/other 4xx).
          if (!retryable) {
            throw new LlmFatalError(
              `LLM_FATAL: non-retryable transport failure (${errorClass}): ${te.message ?? ""}`.trim(),
              errorClass,
            );
          }

          // Transient: if this was the last attempt, retries are exhausted → fatal.
          if (attempt >= MAX_ATTEMPTS) {
            throw new LlmFatalError(
              `LLM_FATAL: retries exhausted after ${MAX_ATTEMPTS} attempts (${errorClass})`,
              "exhausted",
            );
          }

          // Otherwise compute the backoff, emit llm-retry, sleep, and retry.
          const retryAfterMs =
            typeof te.retryAfterSeconds === "number"
              ? te.retryAfterSeconds * 1000
              : undefined;
          const delayMs = computeBackoffMs(attempt, random01(), retryAfterMs);
          deps.onRetry?.({ attempt, errorClass, delayMs });
          await sleep(delayMs);
        }
      }
      // Unreachable: the loop always returns or throws within MAX_ATTEMPTS.
      throw new LlmFatalError(
        `LLM_FATAL: retries exhausted (${lastErrorClass})`,
        "exhausted",
      );
    },
  };
}

/**
 * Thin REAL transport wrapper (SEAM-EXCLUDED, not exercised by any test). It is
 * provided for completeness so a production composition can wrap the SDK; it
 * reads `modelId` from Config (NEVER hardcodes a model) and binds the API key at
 * construction. The actual Anthropic SDK call body is intentionally NOT
 * implemented here — building it is out of scope for this slice (test strategy
 * seam-exclusion). Any production wiring supplies its own transport.
 */
export function createSdkTransport(opts: {
  apiKey: string;
  modelId: string;
}): LlmTransport {
  // modelId is read from Config (never hardcoded). The SDK call body is
  // out of scope this slice; a production build provides the real transport.
  void opts.apiKey;
  void opts.modelId;
  return async () => {
    throw new LlmFatalError(
      "LLM_FATAL: real SDK transport is not wired in this build (seam-excluded). " +
        "Inject a transport via createLlmClient({ transport }).",
      "not_wired",
    );
  };
}

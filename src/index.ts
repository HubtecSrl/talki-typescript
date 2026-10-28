/**
 * The TypeScript client for the Talki API.
 *
 *     import { Talki } from "@hubtec/talki";
 *
 *     const talki = new Talki({ apiKey: "talki_test_…" });
 *     const account = await talki.account.get();
 */

export { API_KEY_ENV, DEFAULT_BASE_URL, Talki, type TalkiOptions, USER_AGENT } from "./client.js";
export type { RawResponse, RequestOptions } from "./core.js";
export {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  TalkiError,
} from "./errors.js";
export { API_VERSION } from "./generated/api-version.js";
export type * from "./generated/models.js";
export * from "./generated/resources.js";
export type { components, operations, paths } from "./generated/schema.js";
export type { Logger, LogLevel } from "./logging.js";
export {
  authorizationUrl,
  createPkce,
  OAuthApp,
  OAuthError,
  type Pkce,
  readCallback,
  type TokenSet,
} from "./oauth.js";
export { Page, PagePromise, PaginationError, position } from "./pagination.js";
export { newIdempotencyKey } from "./transport.js";
export { VERSION } from "./version.js";
export {
  constructEvent,
  SignatureVerificationError,
  signatureOf,
  verifySignature,
  type WebhookEvent,
} from "./webhooks.js";

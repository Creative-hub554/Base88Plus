export interface ProjectFile {
  path: string;
  content: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Per-project model pin; falls back to the global default when unset. */
  modelOverride?: { providerId: string; modelId: string };
  /** Custom domains attached to this project's Worker. */
  customDomains?: CustomDomain[];
  /** Last successful Cloudflare deploy, if any. */
  deployment?: DeployInfo;
  /** Set on template-library projects (generated once for the /new gallery). */
  template?: {
    id: string;
    briefHash: string;
    /** Hash of the system prompt the demo was generated with. */
    promptHash?: string;
    generatedAt: string;
  };
  /**
   * Set when a project was created by promoting a cached template demo
   * (its files were copied, not regenerated). Purely informational.
   */
  fromTemplate?: { id: string; name: string; promotedAt: string };
  /**
   * Pinned best version: the turn snapshot publishing always ships,
   * independent of the live workspace. Cleared when that version is
   * restored into the workspace or the pin is manually removed.
   */
  pinnedSnapshot?: { messageId: string; pinnedAt: string };
}

/**
 * A custom domain attached (or attachable) to the project's Cloudflare
 * Worker. "managed" = the zone lives on the user's Cloudflare account, so
 * Cloudflare creates DNS automatically. "manual" = the zone is elsewhere;
 * the user must add the CNAME record themselves.
 */
export interface CustomDomain {
  hostname: string;
  zoneId?: string;
  mode: "managed" | "manual";
  attachedAt: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: "openai" | "openai-compatible";
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Model id shown to users, e.g. "gpt-5.2", "claude-sonnet-4-5", "llama3.2" */
  defaultModel: string;
  /** Whether the provider currently has credentials configured */
  configured: boolean;
  /** Extra user-facing note shown in settings UI */
  note?: string;
}

export interface Settings {
  providers: ProviderConfig[];
  activeProviderId?: string;
  activeModel?: string;
  /** Cloudflare deploy credentials (BYOK). apiKey is never sent to the client. */
  cloudflare?: {
    accountId?: string;
    apiKey?: string;
    /** workers.dev subdomain, e.g. "my-team" in https://foo.my-team.workers.dev */
    subdomain?: string;
  };
}

export interface DeployInfo {
  /** Worker name == published slug; the workers.dev URL derives from it. */
  workerName: string;
  url: string;
  deployedAt: string;
  /** Which stored version the live URL currently serves. */
  version?: number;
}

/**
 * A stored deployment version: an immutable copy of the files that were
 * pushed to Cloudflare, kept so users can view and roll back to it.
 */
export interface DeployVersion {
  version: number;
  deployedAt: string;
  /** Snapshot of file paths included in this deploy. */
  files: string[];
  /** Public URL that was live for this deploy. */
  url: string;
  /** The publish slug at deploy time. */
  slug: string;
}

export interface PublishManifest {
  slug: string;
  publishedAt: string;
  /** Files published in the latest snapshot. */
  files: string[];
  /** Last Cloudflare deploy for this snapshot, if any. */
  deployment?: DeployInfo;
  /** Set when the published files came from the pinned best version. */
  pinnedFrom?: string;
}

export type FileAction = "create" | "update" | "delete";

export interface FileUpdate {
  path: string;
  action: FileAction;
  /** undefined for delete */
  content?: string;
}

export interface BuilderUIMessageMetadata {
  /**
   * The turn produced no files despite the automatic retry — the chat
   * shows a one-click Continue button after it. Server-computed via
   * shouldOfferContinue; the client never re-derives this.
   */
  degenerate?: boolean;
  modelUsed?: string;
  providerUsed?: string;
  fileCount?: number;
  /** True when the server auto-retried a degenerate/incomplete generation. */
  retried?: boolean;
  /** True when a provider hit its quota/rate limit during this message. */
  quotaFallback?: boolean;
  /**
   * A degenerate first attempt had partially written files (progressive
   * streaming persists completed sections pre-fence); the workspace was
   * rolled back before the retry. Server-computed count of reverted
   * files; the chat footer shows what the user almost saw.
   */
  rolledBackFiles?: number;
}

/**
 * UIMessage with typed data parts: `data-files` carries file updates
 * streamed from the server while the model generates.
 */
export type BuilderUIMessage = import("ai").UIMessage<
  BuilderUIMessageMetadata,
  { files: FileUpdate[] }
>;

export const INTERNAL_DIRS = ["src", "app", "components", "styles"];

import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export interface ModelServices {
  runtime: ModelRuntime;
  registry: ModelRegistry;
}

export interface ModelFilesRevision {
  models: string;
  auth: string;
}

interface RefreshOutcome {
  services: ModelServices;
  applied: boolean;
}

interface ModelServicesCacheOptions {
  readRevision?: () => Promise<ModelFilesRevision>;
  create?: () => Promise<ModelServices>;
  refreshAuth?: (services: ModelServices) => Promise<void>;
  onError?: (reason: "models" | "auth", error: unknown) => void;
}

const MODEL_REFRESH_TIMEOUT_MS = 10_000;

async function fileRevision(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "missing";
    }
    throw error;
  }
}

export async function readModelFilesRevision(): Promise<ModelFilesRevision> {
  const agentDir = getAgentDir();
  const [models, auth] = await Promise.all([
    fileRevision(join(agentDir, "models.json")),
    fileRevision(join(agentDir, "auth.json")),
  ]);
  return { models, auth };
}

function sameRevision(
  left: ModelFilesRevision | undefined,
  right: ModelFilesRevision,
): boolean {
  return left?.models === right.models && left.auth === right.auth;
}

async function createModelServices(): Promise<ModelServices> {
  // ModelRuntime.create() already performs one refresh. Keep it local and
  // bounded; an interactive model picker must not wait on remote catalogs.
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  });
  return { runtime, registry: new ModelRegistry(runtime) };
}

async function refreshModelAuth(services: ModelServices): Promise<void> {
  await services.runtime.refresh({
    allowNetwork: false,
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  });
}

function assertHealthyModelServices(services: ModelServices): void {
  const error = services.registry.getError();
  if (!error) return;
  throw new Error(`model registry refresh failed: ${error}`);
}

/** Validate a candidate models.json without touching the live runtime or auth. */
export async function validateModelConfigFile(path: string): Promise<void> {
  const runtime = await ModelRuntime.create({
    modelsPath: path,
    // A unique non-existent credential path keeps config validation isolated
    // from a concurrently written or malformed live auth.json.
    authPath: `${path}.validation-auth-missing`,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
}

/**
 * Keeps the relatively expensive model runtime warm while observing both
 * model configuration and credentials written by another pi/Codex process.
 */
export class ModelServicesCache {
  private services: ModelServices | undefined;
  private revision: ModelFilesRevision | undefined;
  private inFlight: Promise<RefreshOutcome> | undefined;
  private invalidation = 0;
  private appliedInvalidation = -1;
  private readonly readRevision: () => Promise<ModelFilesRevision>;
  private readonly create: () => Promise<ModelServices>;
  private readonly refreshAuth: (services: ModelServices) => Promise<void>;
  private readonly onError: (
    reason: "models" | "auth",
    error: unknown,
  ) => void;

  constructor(options: ModelServicesCacheOptions = {}) {
    this.readRevision = options.readRevision ?? readModelFilesRevision;
    this.create = options.create ?? createModelServices;
    this.refreshAuth = options.refreshAuth ?? refreshModelAuth;
    this.onError =
      options.onError ??
      ((reason, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[models] cache_refresh_failed reason=${reason} error=${JSON.stringify(message)}`,
        );
      });
  }

  /** Force the next caller to compare/rebuild even on coarse-mtime filesystems. */
  invalidate(): void {
    this.invalidation += 1;
  }

  async get(): Promise<ModelServices> {
    // A file can change while an earlier refresh is running. Re-check after
    // joining the single-flight so all callers converge on the newest state.
    for (let attempt = 0; attempt < 3; attempt++) {
      const requested = await this.readRevision();
      const requestedInvalidation = this.invalidation;
      if (
        this.services &&
        this.appliedInvalidation === requestedInvalidation &&
        sameRevision(this.revision, requested)
      ) {
        return this.services;
      }

      const outcome = await this.refresh(requested, requestedInvalidation);
      if (!outcome.applied) return outcome.services;
    }

    // Continuously rewritten credential files should not make /api/models
    // unavailable. Return the newest complete snapshot and refresh next time.
    if (this.services) return this.services;
    throw new Error("model services did not initialize");
  }

  private async refresh(
    requested: ModelFilesRevision,
    requestedInvalidation: number,
  ): Promise<RefreshOutcome> {
    if (this.inFlight) return this.inFlight;

    const previousServices = this.services;
    const previousRevision = this.revision;
    const reason: "models" | "auth" =
      !previousServices ||
      this.appliedInvalidation !== requestedInvalidation ||
      previousRevision?.models !== requested.models
        ? "models"
        : "auth";

    const task = (async (): Promise<RefreshOutcome> => {
      try {
        let next = previousServices;
        if (reason === "models") {
          next = await this.create();
        } else {
          await this.refreshAuth(next!);
        }
        // ModelRuntime records malformed models.json and provider composition
        // failures instead of rejecting refresh(). Convert that state into a
        // failed cache refresh so a partial write cannot replace the last
        // complete model list.
        assertHealthyModelServices(next!);
        this.services = next;
        this.revision = requested;
        this.appliedInvalidation = requestedInvalidation;
        return { services: next!, applied: true };
      } catch (error) {
        this.onError(reason, error);
        if (previousServices) {
          return { services: previousServices, applied: false };
        }
        throw error;
      }
    })();
    this.inFlight = task;
    try {
      return await task;
    } finally {
      if (this.inFlight === task) this.inFlight = undefined;
    }
  }
}

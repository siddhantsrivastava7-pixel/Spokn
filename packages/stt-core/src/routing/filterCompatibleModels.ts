import type { STTModelMetadata } from "../types";
import type { ModelSelectionContext, RejectedCandidate } from "../types/routingTypes";
import { getAllModels, getModelById } from "../models/modelRegistry";
import { incompatibilityReason, supportsLanguage } from "../models/modelCapabilities";

export interface FilterResult {
  compatible: STTModelMetadata[];
  rejected: RejectedCandidate[];
  /** Set when an exactModelId was validated and should be returned immediately. */
  pinnedModel?: STTModelMetadata;
}

/**
 * Stage 1 of two-stage routing — hard constraint filtering.
 *
 * A model must pass ALL of the following to remain in the candidate pool:
 *   1. Registered in the model registry
 *   2. Compatible with device (RAM, storage, CPU tier)
 *   3. Supports the requested language
 *   4. Supports offline if offlineOnly is set
 *   5. Is installed (when installedModelIds is provided)
 *
 * Returns a clean separation of compatible vs. rejected models with reasons.
 * Does not do any scoring — that is Stage 2.
 */
export function filterCompatibleModels(context: ModelSelectionContext): FilterResult {
  const { settings, device, installedModelIds } = context;
  const rejected: RejectedCandidate[] = [];
  const all = getAllModels();

  // ── exactModelId fast path ────────────────────────────────────────────────
  if (settings.exactModelId) {
    const pinned = getModelById(settings.exactModelId);

    if (!pinned) {
      rejected.push({
        modelId: settings.exactModelId,
        reason: `Model "${settings.exactModelId}" is not in the registry`,
      });
    } else {
      const platformIssue = pinned.supportedPlatforms && !pinned.supportedPlatforms.includes(device.platform);
      const deviceIssue = incompatibilityReason(pinned, device);
      if (platformIssue) {
        rejected.push({ modelId: pinned.id, reason: `Exact model "${pinned.displayName}" does not support platform "${device.platform}"` });
      } else if (deviceIssue) {
        rejected.push({ modelId: pinned.id, reason: `Exact model skipped: ${deviceIssue}` });
      } else if (!supportsLanguage(pinned, settings.language)) {
        rejected.push({
          modelId: pinned.id,
          reason: `Exact model "${pinned.displayName}" does not support language "${settings.language}"`,
        });
      } else if (settings.offlineOnly && !pinned.capabilities.supportsOffline) {
        rejected.push({
          modelId: pinned.id,
          reason: `Exact model "${pinned.displayName}" does not support offline mode`,
        });
      } else if (installedModelIds && !installedModelIds.includes(pinned.id)) {
        rejected.push({
          modelId: pinned.id,
          reason: `Exact model "${pinned.displayName}" is not installed on this device`,
        });
      } else {
        // Pin is valid — skip full filter and return it directly
        return { compatible: [], rejected, pinnedModel: pinned };
      }
    }
    // Fall through to normal routing if pin failed
  }

  // ── Normal candidate pool ─────────────────────────────────────────────────
  const compatible: STTModelMetadata[] = [];

  for (const model of all) {
    // Skip the exact model id — it was already handled above (and rejected)
    if (settings.exactModelId && model.id === settings.exactModelId) continue;

    if (model.supportedPlatforms && !model.supportedPlatforms.includes(device.platform)) {
      rejected.push({
        modelId: model.id,
        reason: `"${model.displayName}" does not support platform "${device.platform}"`,
      });
      continue;
    }

    const deviceIssue = incompatibilityReason(model, device);
    if (deviceIssue) {
      rejected.push({ modelId: model.id, reason: deviceIssue });
      continue;
    }

    if (!supportsLanguage(model, settings.language)) {
      rejected.push({
        modelId: model.id,
        reason: `"${model.displayName}" does not support language "${settings.language}"`,
      });
      continue;
    }

    if (settings.offlineOnly && !model.capabilities.supportsOffline) {
      rejected.push({
        modelId: model.id,
        reason: `"${model.displayName}" does not support offline mode`,
      });
      continue;
    }

    if (installedModelIds && !installedModelIds.includes(model.id)) {
      rejected.push({
        modelId: model.id,
        reason: `"${model.displayName}" is not installed`,
      });
      continue;
    }

    compatible.push(model);
  }

  return { compatible, rejected };
}

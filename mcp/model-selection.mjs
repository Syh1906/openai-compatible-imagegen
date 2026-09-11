import { createHash } from "node:crypto";
import { z } from "zod";
import contract from "../scripts/model-profile-contract.json" with { type: "json" };

export const modelSelectionSchema = z.object({
  authMode: z.enum(["apikey", "chatgpt"]),
  modelProfileId: z.string().min(1).optional(),
  selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  parameters: z.record(z.unknown()).optional(),
  output: z.object({
    size: z.string().optional(), quality: z.string().optional(), format: z.string().optional(),
    aspectRatio: z.string().optional(), resolution: z.string().optional(), background: z.string().optional(),
  }).strict().optional(),
}).strict();

export function resolveModelSelection(context, selection) {
  const config = context.apiRuntimeConfig ?? JSON.parse(context.effectiveConfigJson || "{}");
  const models = config.models || {};
  let id = selection ?? config.active_profile ?? context.activeProfile;
  if (!Object.hasOwn(models, id)) {
    const alias = String(id).normalize("NFKC").trim().toLowerCase();
    const aliases = Object.entries(models).filter(([, model]) => (model.aliases || []).some((value) => value.normalize("NFKC").trim().toLowerCase() === alias));
    const matches = aliases.length ? aliases : Object.entries(models).filter(([, model]) => model.model === id);
    if (matches.length !== 1) throw selectionError("unsupported_model_profile", matches.length ? "model selection is ambiguous" : "model selection is not configured");
    id = matches[0][0];
  }
  const profile = models[id];
  const provider = { ...config.providers[profile.provider] };
  delete provider.api_key;
  const frozen = {
    contract: contract.version, profileId: id, profile, provider,
    defaults: config.defaults || {},
    transparency: (config.config_version === 1 ? config.transparency : profile.transparency) ?? null,
  };
  return { modelProfileId: id, selectionFingerprint: createHash("sha256").update(canonical(frozen)).digest("hex") };
}

export function bindCanvasSelection(context, request, selection) {
  if (!selection) return request;
  modelSelectionSchema.parse(selection);
  if (selection.authMode !== "apikey") throw selectionError("edit_submission_mismatch", "canvas submission requires the ChatGPT route");
  const resolved = resolveModelSelection(context, selection.modelProfileId);
  if (selection.selectionFingerprint && resolved.selectionFingerprint !== selection.selectionFingerprint) throw selectionError("image_config_changed", "canvas model configuration changed; reopen and resubmit");
  if (request.modelProfileId && resolveModelSelection(context, request.modelProfileId).modelProfileId !== resolved.modelProfileId) throw selectionError("edit_submission_mismatch", "canvas model selection does not match request");
  if (request.parameters && canonical(request.parameters) !== canonical(selection.parameters || {})) throw selectionError("edit_submission_mismatch", "canvas parameters do not match request");
  if (selection.output) {
    for (const key of ["size", "quality", "format", "aspectRatio", "resolution", "background"]) {
      if (request[key] !== undefined && request[key] !== selection.output[key]) throw selectionError("edit_submission_mismatch", "canvas output parameters do not match request");
    }
  }
  return { ...request, ...selection.output, modelProfileId: resolved.modelProfileId, ...(selection.parameters ? { parameters: structuredClone(selection.parameters) } : {}) };
}

export function modelDefaultOutput(context, profileId) {
  const config = context.apiRuntimeConfig ?? JSON.parse(context.effectiveConfigJson);
  const defaults = config.config_version === 2 ? config.models[profileId].defaults || {} : config.defaults || {};
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => contract.imageDefaultKeys.includes(key))
    .map(([key, value]) => [key === "output_format" ? "format" : key === "aspect_ratio" ? "aspectRatio" : key, value]));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function selectionError(code, message) {
  return Object.assign(new Error(message), { code });
}

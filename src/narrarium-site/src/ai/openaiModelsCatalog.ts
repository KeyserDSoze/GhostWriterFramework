export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface OpenAIModelsResponse {
  object?: string;
  data?: unknown;
}

export function openAIModelsUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  if (!base) throw new Error("OpenAI-compatible endpoint is required.");
  return `${base}/models`;
}

export function parseOpenAIModels(payload: unknown): OpenAICompatibleModel[] {
  const data: unknown[] = payload && typeof payload === "object" && Array.isArray((payload as OpenAIModelsResponse).data)
    ? ((payload as OpenAIModelsResponse).data as unknown[])
    : Array.isArray(payload)
      ? payload
      : [];
  const seen = new Set<string>();
  const models: OpenAICompatibleModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = entry as Partial<OpenAICompatibleModel>;
    models.push({
      id,
      ...(typeof model.object === "string" ? { object: model.object } : {}),
      ...(typeof model.created === "number" ? { created: model.created } : {}),
      ...(typeof model.owned_by === "string" ? { owned_by: model.owned_by } : {}),
    });
  }
  return models;
}

/** Fetch one selectable model catalog from an OpenAI-compatible /v1 endpoint. */
export async function fetchOpenAICompatibleModels(endpoint: string, apiKey: string): Promise<OpenAICompatibleModel[]> {
  const response = await fetch(openAIModelsUrl(endpoint), {
    headers: {
      Accept: "application/json",
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`OpenAI-compatible models: ${response.status} ${response.statusText}`);
  return parseOpenAIModels(await response.json());
}

import { classifyRepositoryError, RepositoryError } from "@/repository/repositoryError";
import { RepositoryByteMeter, assertRepositoryAggregateBytes, assertRepositoryFileBytes, repositoryFileLimit, type RepositoryContentKind } from "@/repository/repositoryLimits";

function blobUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
}

export async function fetchRepositoryBlobBytes(input: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  sha: string;
  kind: RepositoryContentKind;
  meter: RepositoryByteMeter;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  input.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(blobUrl(input.owner, input.repo, input.sha), {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: input.signal,
    });
  } catch (error) {
    throw classifyRepositoryError(error, "read", input.path);
  }
  if (!response.ok) throw classifyRepositoryError({ status: response.status, response: { status: response.status, headers: Object.fromEntries(response.headers) } }, "read", input.path);
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new RepositoryError("GitHub returned JSON instead of raw blob content.", "malformed", "read", 200);

  return readBoundedRepositoryResponse(response, input.kind, input.meter, input.signal);
}

export async function readBoundedRepositoryResponse(response: Response, kind: RepositoryContentKind, meter: RepositoryByteMeter, signal?: AbortSignal, allowedBytes = repositoryFileLimit(kind)): Promise<Uint8Array> {
  const fileLimit = allowedBytes;
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised >= 0) {
    assertRepositoryFileBytes(kind, advertised, fileLimit);
    assertRepositoryAggregateBytes(meter.measuredBytes + advertised, meter.scope, meter.allowedBytes);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    meter.add(kind, bytes.byteLength, fileLimit);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let fileBytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      fileBytes += value.byteLength;
      meter.addChunk(kind, value.byteLength, fileBytes, fileLimit);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(fileBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

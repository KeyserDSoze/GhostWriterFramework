export function isMediaOperationOwned(
  activeGeneration: number,
  expectedGeneration: number,
  aborted: boolean,
): boolean {
  return !aborted && activeGeneration === expectedGeneration;
}

export function stopMediaStreamTracks(stream: Pick<MediaStream, "getTracks"> | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

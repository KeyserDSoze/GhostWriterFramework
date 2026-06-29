export interface UsageBucket {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  chatCost: number;
  imageCount: number;
  imageInputTextTokens: number;
  imageCachedInputTextTokens: number;
  imageInputImageTokens: number;
  imageCachedInputImageTokens: number;
  imageOutputTokens: number;
  imageCost: number;
  ttsChars: number;
  ttsCost: number;
  sttHours: number;
  sttCost: number;
}

export interface BookUsage extends UsageBucket {
  bookId: string;
  bookName?: string;
}

export interface CostsFile {
  version: 1;
  currency: "EUR";
  updatedAt: string;
  books: Record<string, BookUsage>;
}

export function emptyBucket(): UsageBucket {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    chatCost: 0,
    imageCount: 0,
    imageInputTextTokens: 0,
    imageCachedInputTextTokens: 0,
    imageInputImageTokens: 0,
    imageCachedInputImageTokens: 0,
    imageOutputTokens: 0,
    imageCost: 0,
    ttsChars: 0,
    ttsCost: 0,
    sttHours: 0,
    sttCost: 0,
  };
}

export function emptyCostsFile(): CostsFile {
  return { version: 1, currency: "EUR", updatedAt: new Date().toISOString(), books: {} };
}

export function bucketTotal(b: UsageBucket): number {
  return b.chatCost + b.imageCost + b.ttsCost + b.sttCost;
}

export function addBucket(target: UsageBucket, delta: Partial<UsageBucket>): UsageBucket {
  return {
    inputTokens: target.inputTokens + (delta.inputTokens ?? 0),
    cachedTokens: target.cachedTokens + (delta.cachedTokens ?? 0),
    outputTokens: target.outputTokens + (delta.outputTokens ?? 0),
    chatCost: target.chatCost + (delta.chatCost ?? 0),
    imageCount: target.imageCount + (delta.imageCount ?? 0),
    imageInputTextTokens: target.imageInputTextTokens + (delta.imageInputTextTokens ?? 0),
    imageCachedInputTextTokens: target.imageCachedInputTextTokens + (delta.imageCachedInputTextTokens ?? 0),
    imageInputImageTokens: target.imageInputImageTokens + (delta.imageInputImageTokens ?? 0),
    imageCachedInputImageTokens: target.imageCachedInputImageTokens + (delta.imageCachedInputImageTokens ?? 0),
    imageOutputTokens: target.imageOutputTokens + (delta.imageOutputTokens ?? 0),
    imageCost: target.imageCost + (delta.imageCost ?? 0),
    ttsChars: target.ttsChars + (delta.ttsChars ?? 0),
    ttsCost: target.ttsCost + (delta.ttsCost ?? 0),
    sttHours: target.sttHours + (delta.sttHours ?? 0),
    sttCost: target.sttCost + (delta.sttCost ?? 0),
  };
}

export function aggregateAll(file: CostsFile): UsageBucket {
  return Object.values(file.books).reduce((acc, b) => addBucket(acc, b), emptyBucket());
}

export async function resolveUnsavedChanges(options: {
  dirty: boolean;
  save: () => boolean | Promise<boolean>;
  saveMessage: string;
  discardMessage: string;
}): Promise<boolean> {
  if (!options.dirty) return true;
  if (window.confirm(options.saveMessage)) return options.save();
  return window.confirm(options.discardMessage);
}

const key = "zhihui:homepage-task";
export function readHomepageDraft(): string {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      typeof draft?.text === "string" &&
      typeof draft?.savedAt === "number" &&
      Date.now() - draft.savedAt < 30 * 60 * 1000
    )
      return draft.text.slice(0, 6000);
  } catch {
    /* Storage can be unavailable in private browsers. */
  }
  return "";
}
export function saveHomepageDraft(text: string) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ text, savedAt: Date.now() }));
  } catch {
    /* Login remains available without draft storage. */
  }
}
export function clearHomepageDraft() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}

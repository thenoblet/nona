// Whether the open section has edits that aren't saved, so the links and menu that leave it can ask
// first. The editor sets it; there is only ever one editor on the page.
let unsavedChanges = false;

export function setUnsavedChanges(value: boolean) {
  unsavedChanges = value;
}

/** True when it's fine to leave the section: nothing is unsaved, or the couple said to go anyway. */
export function confirmLeave(): boolean {
  return !unsavedChanges || window.confirm("Leave without saving?");
}

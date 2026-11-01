/*
 * What this phone's browser can do for the viewer (gate B 1c and 1e). Read once the viewer opens,
 * in the browser only.
 */

/**
 * Whether the browser is an app's own (WhatsApp's, or another Android app's web view), where
 * downloads often stop half way and files can't be handed to the share menu: the viewer says to
 * open the page in the phone's browser, and offers Copy link instead of Save to Photos.
 */
export function inAppBrowser(userAgent: string): boolean {
  return /WhatsApp/i.test(userAgent) || (/Android/i.test(userAgent) && /; wv\)/.test(userAgent));
}

/** Whether the browser can hand a file to the phone's share menu (Save to Photos's second tap). */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], "moment.jpg", { type: "image/jpeg" });
    return typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Copies the text, with the old way where the clipboard isn't offered (some in-app browsers). True when it did. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

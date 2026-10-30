/** Keys used to decide whether two replies are from the same guest. */

export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "") // combining marks only; letters such as Ɔ and Ɛ stay
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * The digits of a phone number, with every way of writing a Ghana number read as the local form:
 * "024 000 0000", "+233 24 000 0000", "+233 (0)24 000 0000" and "00233 24 000 0000" are all
 * "0240000000". A leading 00 is read as +, so a number from abroad matches either way too.
 */
export function phoneKey(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("233")) {
    let national = digits.slice(3);
    // "+233 (0)24…": the local 0 kept after the country code.
    if (national.length === 10 && national.startsWith("0")) national = national.slice(1);
    if (national.length === 9) return `0${national}`;
  }
  return digits;
}

/**
 * What a search for a typed number looks for in a stored number's phoneKey: the typed number's own
 * phoneKey and, while it is typed only partly after the country code ("+233 24", "00233 (0)24"),
 * its local form too ("024"), since phoneKey reads 233 as the country code only in a whole number.
 * Nothing when no digit is typed beyond a leading 00.
 */
export function phoneSearchKeys(typed: string): string[] {
  const key = phoneKey(typed);
  if (!key) return [];
  if (!key.startsWith("233") || key.length === 3) return [key];
  // "+233 (0)24": the local 0 kept after the country code.
  return [key, `0${key.slice(3).replace(/^0/, "")}`];
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

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

export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("233") ? `0${digits.slice(3)}` : digits;
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

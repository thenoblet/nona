/**
 * A phone number as a link that dials it from anywhere: "024 459 0772" becomes
 * "tel:+233244590772", so guests calling from abroad reach Ghana too. A number typed with its
 * country code ("+44 20 7946 0958") keeps it.
 */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return `tel:${digits}`;
  if (digits.startsWith("0")) return `tel:+233${digits.slice(1)}`;
  return `tel:${digits}`;
}

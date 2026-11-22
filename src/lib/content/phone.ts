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

/**
 * A WhatsApp chat with a phone number: "055 936 8495" becomes "https://wa.me/233559368495", which
 * opens WhatsApp on a phone and WhatsApp Web elsewhere. A number with its own country code keeps
 * it. `text`, if given, is written in the chat ready to send.
 */
export function whatsappHref(phone: string, text?: string): string {
  const number = telHref(phone).replace(/^tel:\+?/, "");
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

import { redirect } from "next/navigation";

/** The admin opens on the replies. */
export default function AdminPage() {
  redirect("/admin/rsvps");
}

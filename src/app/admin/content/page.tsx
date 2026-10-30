import { redirect } from "next/navigation";

/** Site text opens on the celebrations. */
export default function ContentPage() {
  redirect("/admin/content/celebrations");
}

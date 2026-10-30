import { Suspense } from "react";
import { AdminGate } from "@/components/admin/AdminGate";

// Placeholder until the Replies page replaces it.
export default function AdminPage() {
  return (
    <Suspense>
      <AdminGate>{() => <h1>Admin</h1>}</AdminGate>
    </Suspense>
  );
}

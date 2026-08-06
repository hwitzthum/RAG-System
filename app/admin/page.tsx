export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server-session";
import AdminPanel from "./admin-panel";

export default async function AdminPage() {
  const user = await getServerSessionUser();

  if (!user || user.role !== "admin") {
    redirect("/");
  }

  return (
    <main className="min-h-screen p-6 md:p-12">
      <AdminPanel currentUserId={user.id} />
    </main>
  );
}

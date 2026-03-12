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
    <main className="min-h-screen bg-zinc-50 p-4 md:p-8">
      <AdminPanel currentUserId={user.id} />
    </main>
  );
}

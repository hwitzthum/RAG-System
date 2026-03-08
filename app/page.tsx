import { RagWorkbench } from "@/components/rag-workbench";
import { getServerSessionUser } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getServerSessionUser();

  return (
    <main>
      <h1>Hello</h1>
      <RagWorkbench initialUser={user} />
    </main>
  );
}

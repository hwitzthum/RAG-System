import { RagWorkbench } from "@/components/rag-workbench";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main>
      <h1>Hello</h1>
      <RagWorkbench initialUser={null} />
    </main>
  );
}

import { notFound } from "next/navigation";
import { getProject, listAppFiles, loadMessages } from "@/lib/store";
import { BuilderClient } from "@/components/builder-client";
import type { BuilderUIMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AppPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const messages = loadMessages(projectId);
  const files = listAppFiles(projectId);

  return (
    <BuilderClient
      projectId={projectId}
      initialMessages={messages as BuilderUIMessage[]}
      initialFiles={files}
    />
  );
}

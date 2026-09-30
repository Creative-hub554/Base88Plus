import { notFound } from "next/navigation";
import { getProject, listAppFiles, loadMessages } from "@/lib/store";
import { BuilderClient } from "@/components/builder-client";
import type { BuilderUIMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AppPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ kickoff?: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const messages = loadMessages(projectId);
  const files = listAppFiles(projectId);

  // Handoff from /new: auto-send the stored brief as the first chat
  // message so creating an app starts generating it. Gated server-side on
  // a truly fresh project (zero messages) so a refresh or back/forward
  // revisit can never re-trigger a generation; the client strips the
  // query param after consuming it.
  const kickoffBrief =
    (await searchParams).kickoff === "1" &&
    messages.length === 0 &&
    project.description.trim()
      ? project.description.trim()
      : null;

  return (
    <BuilderClient
      projectId={projectId}
      initialMessages={messages as BuilderUIMessage[]}
      initialFiles={files}
      kickoffBrief={kickoffBrief}
      initialName={project.name}
    />
  );
}

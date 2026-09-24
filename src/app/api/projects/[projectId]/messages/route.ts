import { NextRequest } from "next/server";
import { loadMessages } from "@/lib/store";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  return Response.json({ messages: loadMessages(projectId) });
}

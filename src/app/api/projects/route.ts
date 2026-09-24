import { NextRequest } from "next/server";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
} from "@/lib/store";

export async function GET() {
  return Response.json({ projects: listProjects() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { name?: string; description?: string };
  const name = body.name?.trim() || "Untitled app";
  const project = createProject(name, body.description?.trim() || "");
  return Response.json({ project }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  deleteProject(id);
  return Response.json({ ok: true });
}

export function PUT() {
  return Response.json({ error: "Not supported" }, { status: 405 });
}

export function PATCH() {
  return Response.json({ error: "Not supported" }, { status: 405 });
}

export function HEAD(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response(null, { status: 400 });
  return new Response(null, { status: getProject(id) ? 200 : 404 });
}

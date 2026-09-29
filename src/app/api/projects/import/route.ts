import { NextRequest } from "next/server";
import { importProjectFromZip } from "@/lib/zip-import";

/**
 * The return leg of the portability story: GET .../download exports a
 * project as a zip, POST /api/projects/import brings one back (an
 * Anybase export or any static-site bundle). Every entry is sanitized
 * and per-entry skips are surfaced, so one poison file never 400s the
 * whole import.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with a 'file' field" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json(
      { error: "Missing zip file (field 'file')" },
      { status: 400 },
    );
  }
  const name = (form.get("name") as string | null) ?? undefined;
  const description = (form.get("description") as string | null) ?? undefined;

  const buf = Buffer.from(await file.arrayBuffer());
  // Zip magic: PK\x03\x04 (tolerate empty PK\x05\x06 and spanned PK\x07\x08).
  const isZip =
    buf.length > 3 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 3 || buf[2] === 5 || buf[2] === 7) &&
    (buf[3] === 4 || buf[3] === 6 || buf[3] === 8);
  if (!isZip) {
    return Response.json(
      { error: "The uploaded file is not a zip archive" },
      { status: 400 },
    );
  }

  try {
    const result = await importProjectFromZip(buf, { name, description });
    return Response.json(
      {
        project: result.project,
        importedCount: result.imported.length,
        skipped: result.skipped,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

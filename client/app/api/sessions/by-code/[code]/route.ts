import { forward } from "@/infrastructure/api/proxy";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  return forward(`/api/v1/sessions/by-code/${encodeURIComponent(code.toUpperCase())}`);
}

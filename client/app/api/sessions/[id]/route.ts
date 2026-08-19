import { forward } from "@/infrastructure/api/proxy";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return forward(`/api/v1/sessions/${encodeURIComponent(id)}`);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  // The maestro token travels as a bearer and is never stored here.
  const authorization = request.headers.get("authorization");
  return forward(`/api/v1/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authorization ? { authorization } : undefined,
  });
}

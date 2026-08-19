import { forward } from "@/infrastructure/api/proxy";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forward("/api/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body || "{}",
  });
}

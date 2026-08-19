"use client";

import { use } from "react";

import { PerformStage } from "@/ui/perform/PerformStage";

export default function PerformPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  return <PerformStage sessionId={sessionId} />;
}

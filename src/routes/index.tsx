import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PelagosApp } from "@/components/pelagos/app";

type Search = { a?: string };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const raw = typeof search.a === "string" ? search.a.trim() : "";
    return /^((ocearch|inat):\d{1,12}|whoi:[a-z0-9_-]{1,80})$/.test(raw) ? { a: raw } : {};
  },
  component: Home,
});

function Home() {
  const { a } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const onFocusChange = useCallback(
    (id: string | null) => {
      void navigate({ search: id ? { a: id } : {}, replace: true, resetScroll: false });
    },
    [navigate],
  );
  return <PelagosApp focusId={a ?? null} onFocusChange={onFocusChange} />;
}

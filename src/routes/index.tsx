import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PelagosApp } from "@/components/pelagos/app";
import { parseFocus } from "@/lib/focus";

type Search = { a?: string };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const a = parseFocus(search.a);
    return a ? { a } : {};
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

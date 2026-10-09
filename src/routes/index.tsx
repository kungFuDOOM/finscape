import { createFileRoute } from "@tanstack/react-router";
import { PelagosApp } from "@/components/pelagos/app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <PelagosApp />;
}

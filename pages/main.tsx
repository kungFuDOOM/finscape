import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PelagosApp } from "@/components/pelagos/app";
import "./pages.css";

// The GitHub Pages build: the globe alone, fed by the workflow's data snapshots.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PelagosApp />
  </StrictMode>,
);

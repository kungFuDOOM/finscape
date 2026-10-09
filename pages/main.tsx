import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { PelagosApp } from "@/components/pelagos/app";
import { parseFocus } from "@/lib/focus";
import "./pages.css";

// The GitHub Pages build: the globe alone, fed by the workflow's data snapshots.
// Share links keep the locked signal in `?a=`, like the full app.
function Site() {
  const [focus, setFocus] = useState(() =>
    parseFocus(new URLSearchParams(window.location.search).get("a")),
  );
  const onFocusChange = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("a", id);
    else url.searchParams.delete("a");
    window.history.replaceState(null, "", url);
    setFocus(id);
  }, []);
  return <PelagosApp focusId={focus} onFocusChange={onFocusChange} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);

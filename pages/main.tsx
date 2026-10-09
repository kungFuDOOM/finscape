import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { PelagosApp } from "@/components/pelagos/app";
import { parseFocus } from "@/lib/focus";
import "./site.css";

// GitHub Pages entry: the same app without TanStack Start, keeping `?a=` share links in the URL.
function Site() {
  const [focus, setFocus] = useState(() => parseFocus(new URLSearchParams(window.location.search).get("a")));
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

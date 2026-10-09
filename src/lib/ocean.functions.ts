import { createServerFn } from "@tanstack/react-start";

export const getSignals = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const fresh = Boolean(
      input && typeof input === "object" && "fresh" in input && (input as { fresh?: unknown }).fresh,
    );
    return { fresh };
  })
  .handler(async ({ data }) => {
    const { loadSignals } = await import("./ocean.server");
    return loadSignals(data.fresh);
  });

export const getLiveRoutes = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const fresh = Boolean(
      input && typeof input === "object" && "fresh" in input && (input as { fresh?: unknown }).fresh,
    );
    return { fresh };
  })
  .handler(async ({ data }) => {
    const { loadLiveRoutes } = await import("./ocean.server");
    return loadLiveRoutes(data.fresh);
  });

export const getTrack = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const id =
      input && typeof input === "object" && "id" in input ? Number((input as { id?: unknown }).id) : NaN;
    if (!Number.isInteger(id) || id <= 0 || id > 50_000_000) throw new Error("Missing tag id");
    return { id };
  })
  .handler(async ({ data }) => {
    const { loadTrack } = await import("./ocean.server");
    return loadTrack(data.id);
  });

export type Group = "whale" | "shark" | "dolphin";
export type Kind = "tag" | "heard" | "sighting";
export type SourceId =
  "ocearch" | "wildlife" | "ghri" | "sharksmart" | "whoi" | "acartia" | "inaturalist";

export type CallStatus = "detected" | "possible" | "none";

/** One analyst-reviewed day from a WHOI listening platform. */
export type HeardDay = {
  date: string;
  calls: CallStatus[];
};

/** Acoustic detail for a `heard` signal: which species the platform listens for, and what it heard. */
export type Heard = {
  platform: "buoy" | "glider";
  species: string[];
  recent: string[];
  days: HeardDay[];
};

export type Signal = {
  id: string;
  name: string;
  group: Group;
  common: string;
  scientific: string;
  lat: number;
  lng: number;
  observedAt: string;
  source: SourceId;
  kind: Kind;
  place: string | null;
  sex: string | null;
  length: string | null;
  weight: string | null;
  stage: string | null;
  image: string | null;
  url: string | null;
  tagId: number | null;
  /** The source's own words about this record, e.g. a spotter's report. */
  note?: string | null;
  /** Who recorded it, e.g. the iNaturalist observer. */
  credit?: string | null;
  heard?: Heard | null;
};

export type SourceStatus = {
  id: SourceId;
  label: string;
  ok: boolean;
  count: number;
  note: string | null;
};

export type Feed = {
  fetchedAt: string;
  signals: Signal[];
  sources: SourceStatus[];
};

export type TrackPoint = {
  lat: number;
  lng: number;
  at: string;
};

export type Track = {
  tagId: number;
  points: TrackPoint[];
  error: string | null;
};

export type LiveRoute = {
  id: string;
  name: string;
  group: Group;
  points: TrackPoint[];
};

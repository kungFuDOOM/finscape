export type Group = "whale" | "shark" | "dolphin" | "turtle" | "seal";
export type Kind = "tag" | "sighting";
export type SourceId = "ocearch" | "inaturalist" | "whoi";

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
  /** Who recorded it: the tagging program or the iNaturalist observer. */
  credit: string | null;
  /** Extra context, e.g. how confident an acoustic detection is. */
  note: string | null;
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

// One-off probe: do the Esri imagery and label tiles allow cross-origin reads (needed by WebGL)?
const urls = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/2",
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1582/655",
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/5/12/5",
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/9/198/81",
];
for (const url of urls) {
  const res = await fetch(url, { headers: { Origin: "https://kungfudoom.github.io" } });
  const body = await res.arrayBuffer();
  console.log(res.status, res.headers.get("content-type"), body.byteLength, "ACAO=", res.headers.get("access-control-allow-origin"), url.split("/services/")[1]);
}

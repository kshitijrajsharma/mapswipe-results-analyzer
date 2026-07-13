# MapSwipe Results Analyzer

See MapSwipe project results on a map and export the features you want. It runs as a single static
page in the browser and shows each project's own answer labels in place of the raw `0/1/2` codes.


## Run

Open `index.html` in a browser. If your browser blocks `fetch` from `file://`, serve the folder:

```sh
python3 -m http.server   # then open http://127.0.0.1:8000
```

Paste a project and click Add, for example:
`https://mapswipe.org/en/projects/01KW84AEFPQ0S9NCTN7TPMDN9X/`

## How it works

```mermaid
flowchart LR
  A[Paste project URL] --> B[Read labels + data<br/>from MapSwipe]
  B --> C[Each area gets a result:<br/>Accepted / Others]
  C --> D[Map it: green / grey]
  D --> E[Adjust threshold<br/>and opacity]
  E --> F[Export GeoJSON or CSV]
```

Each area is one MapSwipe task (here, an H3 hexagon). It is **Accepted** if more than your threshold
of mappers said yes, otherwise **Others**.

## Controls

| Control | What it does |
| --- | --- |
| Accept threshold | The share of mappers who must say yes for an area to count as accepted. |
| See-through grid | Fill opacity of the colored areas, so you can see imagery behind them. |
| Show on map | Toggle the accepted and other areas on the map. |
| Project checkbox / imagery / AOI | Toggle the whole project, its satellite imagery, and its area. |
| Download | Save accepted or other areas as GeoJSON, or all areas as CSV. |
| Open in uMap | Open the accepted areas as points in a new editable uMap. |

Areas cluster into counts when zoomed out and become the colored grid when zoomed in. Very large
projects load for counting and download but skip drawing on the map.

## Terms

- **yes / no / not sure**: the answer options for the project, read from MapSwipe and shown by label.
- **AOI**: the project's area of interest.

## Sharing

The URL holds your projects, threshold, and opacity. Copy the address bar to share the exact view.
You can add more than one project.

## Where the data comes from (all read in the browser)

- `mapswipe.org` project page: project id and the results export URL.
- `msf-mapswipe.firebaseio.com`: the question, answer labels, colors, and tile server.
- `backend.mapswipe.org`: the aggregated results (votes per area).

Assets for the README.

- `assets/banner.png`: the banner the README shows (1760x440, 2x of the 880x220 SVG, transparent corners, white card that reads on light and dark backgrounds). Exported from `banner-light.svg` with headless Chrome.
- `assets/banner-light.svg`, `assets/banner-dark.svg`: hand-written SVG sources of the banner. Not used by the README, because some clients (for example the GitHub mobile app) do not render `<picture>` with relative SVGs.
- `assets/demo.gif`: about 10 seconds of the built CLI running with `--offline` against obviously fake keys (no network, no real secrets). Recorded with [vhs](https://github.com/charmbracelet/vhs).

# Mini Skitch-like Annotator

Mini Skitch is a static, browser-only image annotation app for quick screenshot markups. It is inspired by the classic thick red annotation style of old screenshot tools, but it does not use Skitch or Evernote branding and it does not capture screenshots itself.

## What it does

1. Take a screenshot yourself, for example on macOS with `Cmd + Ctrl + Shift + 4` so the screenshot is copied to the clipboard.
2. Open Mini Skitch in a modern browser.
3. Press `Cmd+V` / `Ctrl+V` or click **Paste Image**.
4. Add thick red arrows, rectangles, editable text, numbered callouts, and pixelated blur rectangles.
5. Copy the final PNG back to the clipboard or download `mini-skitch-annotated.png`.

Everything happens locally in the browser. The built app is only static HTML, CSS, and JavaScript, so it can be hosted directly on GitHub Pages. There is no backend, login, analytics, cloud upload, server-side storage, or screenshot-capture service.

## Keyboard shortcuts

Single-letter shortcuts fire when you're not editing a text annotation. They follow the Photoshop / Figma convention.

| Key | Action |
| --- | --- |
| `V` | Select tool |
| `A` | Arrow |
| `R` | Rectangle |
| `T` | Text |
| `S` | Step (numbered callout) |
| `B` | Blur |
| `U` | Undo |
| `Shift+U` | Redo |
| `D` | Delete the selected annotation |
| `C` | Clear all annotations (asks first) |
| `Esc` | Switch back to Select tool |
| `Backspace` / `Delete` | Delete the selected annotation |

Standard editing shortcuts still work:

| Key | Action |
| --- | --- |
| `Cmd+V` / `Ctrl+V` | Paste an image from the clipboard |
| `Cmd+C` / `Ctrl+C` | Copy the annotated PNG to the clipboard |
| `Cmd+Z` / `Ctrl+Z` | Undo |
| `Cmd+Shift+Z` / `Ctrl+Shift+Z` | Redo |

While editing a text annotation, `Cmd+Z` / `Ctrl+Z` follows the text editor's undo behavior; it does not undo a canvas annotation. Finish editing to undo canvas changes. Clicking inside the text moves the caret; clicking outside the canvas ends editing. After editing ends, the text remains selectable with Select, and an empty text annotation is removed.

While a drawing tool is sticky (Rectangle, Arrow, Blur, Text, Step), clicking on an existing annotation auto-switches to Select and picks it up instead of creating a new annotation on top. A Rectangle counts as clicked only on its border and an Arrow only on its drawn line, so clicking inside a Rectangle's empty inside starts the current tool there (for example, typing text inside a box); Blur boxes and Steps are picked up anywhere on them. With the Select tool, clicking inside a Rectangle still selects it.

A text annotation wraps at its box width (drag a side handle to change it). A word too long for the box widens the box to fit; once Enter or Backspace shortens the longest word, the box narrows back to its width, and Freeform's canvas shrinks with it.

The screenshot sits inside a small grey margin so the handles of an annotation at the image edge stay visible and usable. Annotations can overhang the image edge, but a single annotation can't be dragged or resized fully off it: at least a small part always stays on the image so there is still something to grab. A multi-selection is kept partly on the image; if its members' constraints conflict, some members may end up fully off-image. New annotations start and end on the image, so a drag that overshoots the edge stops at the edge. The exported PNG is exactly the screenshot's size and content; the margin and anything hanging past the edge are not included.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL printed in the terminal.

## Build

```bash
npm run build
```

The production files are written to `dist/`.

## Preview the production build

```bash
npm run preview
```

## Static hosting

Yes — this is a pure front-end app. `npm run build` produces static files in `dist/` that can be served by GitHub Pages, Netlify, Cloudflare Pages, S3 static website hosting, or any ordinary static file server. The app does not need Node.js after the build step.

## Deploy to GitHub Pages

The Vite production base is `/always-skitch/`, which matches this repository's GitHub Pages URL:

```text
https://yck2024.github.io/always-skitch/
```

The recommended deployment is GitHub Actions. The repository includes `.github/workflows/deploy-pages.yml`, which builds the static app and deploys the generated `dist/` directory to GitHub Pages when you push to `main`. To use it:
This app uses Vite with `base: './'`, so the built assets work from a repository subpath on GitHub Pages.

The repository includes `.github/workflows/deploy-pages.yml`, which builds the static app and deploys the generated `dist/` directory to GitHub Pages when you push to `main`. To use it:

1. Push this repository to GitHub.
2. In GitHub, open **Settings → Pages**.
3. Set **Build and deployment → Source** to **GitHub Actions**.
4. Push to the `main` branch, or run the **Deploy static app to GitHub Pages** workflow manually from the Actions tab.
5. Wait for the workflow to finish, then open `https://yck2024.github.io/always-skitch/`.

### If the GitHub Pages site is blank

A blank page usually means GitHub Pages is serving the repository root (`index.html`) instead of the production build. The root file points at Vite source code (`/src/main.tsx`), which GitHub Pages cannot compile by itself.

Fix it in one of these ways:

- **Recommended:** set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**, merge this PR into `main`, and let the deploy workflow complete.
- **Branch/folder fallback:** run `npm run build:pages`, commit the generated `docs/` folder, and set **Settings → Pages → Build and deployment → Source** to **Deploy from a branch** with the `main` branch and `/docs` folder.

Manual deployment also works:

1. Run `npm ci`.
2. Run `npm run build`.
3. Publish the generated `dist/` directory to GitHub Pages.

## Browser clipboard limitations

- Clipboard image paste generally requires a secure context: `localhost` during development or an HTTPS site such as GitHub Pages.
- Pressing `Cmd+V` / `Ctrl+V` is the most reliable way to paste images across browsers.
- The **Paste Image** button uses the async Clipboard API, which some browsers may block or require a permission prompt.
- **Copy PNG** uses `ClipboardItem` for `image/png`. If the browser does not support image clipboard writes, Mini Skitch automatically downloads the PNG instead.
- Safari support depends on the Safari version and system clipboard permissions.

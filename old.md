# Marelli Automotive Media Log Analyzer

Open `index.html` directly in a current Chrome/Edge browser. It is fully local: no server, package manager, build step, CDN, or network access is required.

## Files

```
index.html
styles/main.css
js/config.js
js/parser.js
js/stream-reader.js
js/log-store.js
js/filter-engine.js
js/virtual-grid.js
js/app.js
```

## Operating model

The importer reads `File.stream()` through `TextDecoderStream`, preserving only one partial line and a small current batch during ingestion. Rendering is virtualized, so the DOM only contains rows near the viewport.

To guarantee a laptop remains usable on arbitrarily large files, the in-memory analysis window is capped at 750,000 parsed lines (configure `maxRetainedLines` in `js/config.js`). When that cap is exceeded, oldest records are dropped and the final import status states that the newest window was kept. Increase it only after validating the lab workstation's available RAM.

Repository mapping accepts either a JSON array or `{ "classes": [...] }` / `{ "classNames": [...] }`. Both fully-qualified and simple class names are matched against parsed components. The map can be selected as a file or pasted into the in-page Repository class map field.

Plain `adb logcat` text (without a `Line N:` prefix) is supported. The parser extracts time, PID/TID, log level, component/tag, and message. Use the level dropdown, quick-domain toggles, source-component toggle, search, and independently enabled custom-regex filter chips to combine the exact view you need.

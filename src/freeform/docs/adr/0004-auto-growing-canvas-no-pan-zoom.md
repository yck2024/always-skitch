# 0004 Freeform's Canvas auto-grows to fit content; no pan or zoom in MVP

The Freeform **Canvas** has no fixed size. It is sized to the bounding box of all **Images** and **Annotations**, and the display scales the entire canvas to fit the viewport (mirroring how Skitch fits a single **Background** to the window). There is no pan, no zoom, and no scrollbar. Apple Freeform's "infinite canvas" feel is explicitly out of scope for v1.

## Considered options

- **Pan + zoom infinite canvas (true Apple Freeform)**: rejected for MVP. The headline value — multiple **Images** annotated together — is delivered without pan/zoom. Pan/zoom is a multi-week investment (gesture handling, zoom-to-fit, viewport-vs-content export decision, annotation-scale math under variable zoom). Easy to add later as a superset.
- **Fixed virtual canvas (e.g., 4000×3000)**: rejected. Tall screenshots get cramped; users hit a wall they can't see coming.

## Consequences

- Practical soft cap of ~2–4 **Images** per canvas before the display scales them too small for comfortable annotation. Documented as the intended use case.
- Export is unambiguous (bounding box of all content + padding) — no "visible viewport vs. all content" decision needed.
- Annotation scale math stays similar to Skitch (one `displayScale` per canvas), just keyed off the bounding box of all **Images** instead of one **Background's** natural size.
- A V2 zoom (without pan) is the most likely next step if users complain about precision on small displays.

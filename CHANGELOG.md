# Changelog

## 0.0.10

- Remux mp4 output through mp4box.js to produce spec-compliant ISOBMFF containers, fixing a Safari macOS Tahoe bug where video controls never auto-hide

## 0.0.9

- Fixes washed out HDR videos on WebKit and enforced with stricter saturation assertion

## 0.0.8

- fix periodic frame jutter by selecting source frames using mid-frame timestamps instead of boundary timestamps
- improve cadence on some iPhone MOVs by decoding frames via WebCodecs (Mediabunny `VideoSampleSink`) instead of per-frame `<video>` seeks
- avoid accidental 30→60fps upsampling by choosing 60fps only for high-FPS sources

## 0.0.7

- guard against a race condition for forms that subscribe to change events but don't disable submission while optimize is already underway

## 0.0.6

- fix iOS Safari Stimulus controller hang by making `seeked` waits robust

## 0.0.5

- unscrew up the extension in the importmap 🤦‍♂️

## 0.0.4

- Rename mediabunny.min.mjs to mediabunny.min.js because Rails apparently doesn't know the mjs MIME type is text/javascript not text/plain

## 0.0.3

- Add a rubygem because `bin/importmap pin` cannot possibly work with mediabunny.

## 0.0.2

- Change `canOptimizeVideo` return shape to `{ ok, reason, message }`.
- Remove unused `details` (width/height/duration) from `canOptimizeVideo` results.
- Remove pre-encode size budget check (no more `too-long`).
- Surface underlying error messages via the `message` field.

## 0.0.1

* Initial Release

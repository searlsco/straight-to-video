# Changelog

## 0.0.14

* Preserve B-frame presentation timestamps (`ctts`) when normalizing the MP4 container, fixing juddery playback of compliant uploads that were re-muxed on the passthrough path.
* Request an encoder keyframe every 2 seconds so re-encoded videos can recover from seeks, dropped frames, and downstream transcoding (previously the entire video had a single keyframe).

## 0.0.13

* Fast-start already-compliant MP4 and MOV uploads without re-encoding their media packets.
* Preserve compatible 44.1 kHz and 48 kHz AAC audio on the compliant-media path.

## 0.0.12

* Bound the WebCodecs encoder queue so long videos cannot exhaust WebKit memory.
* Keep browser encoding at or below the source video's bitrate.

## 0.0.11

* Work around WebKit labeling the requested first HEVC keyframe as a delta packet.
* Keep browser-encoded video below the 25 Mbps delivery limit.
* Accept WebKit's full-range `yuvj420p` output as progressive 4:2:0 video.

## 0.0.10

- Fix Safari macOS Tahoe bug where native video controls never auto-hide by rewriting the moov atom to match ffmpeg's conventions (zero timestamps, standard handler names, edts/elst, extended esds, btrt, sgpd/sbgp)

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

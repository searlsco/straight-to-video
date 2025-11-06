<p align="center">
  <img width="480" align="center" src="assets/img/logo.webp" alt="straight-to-video VHS Logo">
</p>

# straight-to-video

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)


ESM-only browser module: client-side video optimization helpers + an optional Stimulus controller.

- Exports:
  - `canOptimizeVideo(file)` → Promise<{ ok, reason?, details? }>
  - `optimizeVideo(file, { onProgress }?)` → Promise<{ changed, file }>
  - `registerStraightToVideoController(app, name?)` → registers controller on a Stimulus Application
- Optional peer: `@hotwired/stimulus` (only required if you register the controller)
- Dependency: `mediabunny`

## Install


This package is ESM-only. Use an import map (Rails or plain HTML) or a CDN that serves ESM.

```json
{
  "type": "module"
}
```

## Usage

### API (no Stimulus)

```js
import { canOptimizeVideo, optimizeVideo } from 'straight-to-video'

const ok = await canOptimizeVideo(file)
if (ok.ok) {
  const { changed, file: out } = await optimizeVideo(file, { onProgress: console.log })
}
```

### Stimulus (optional)

I wrote `straight-to-video` to support video workflows for a [couple](https://www.betterwithbecky.com) Rails [apps](https://posseparty.com/). Both apps use [import maps](https://guides.rubyonrails.org/working_with_javascript_in_rails.html#choosing-between-import-maps-and-a-javascript-bundler) and [Stimulus](https://stimulus.hotwired.dev), so the controller that's bundled with this package is how I use `straight-to-video` myself.

Here's how to configure it if you have a similar setup.

```js
// Wherever you wire up Stimulus controllers (e.g. app/javascript/controllers/index.js)
import { application } from 'controllers/application'
import { Controller } from '@hotwired/stimulus'
import { registerStraightToVideoController } from 'straight-to-video'

registerStraightToVideoController(application, { Controller }) // name defaults to "straight-to-video"
```

From there, simply add the `straight-to-video` controller to any of your forms that contain file inputs and flag the inputs for which you want to optimize any video files with the target `fileInput`:

```html
<form data-controller="straight-to-video">
  <input data-straight-to-video-target="fileInput" type="file">
  <!-- The rest of your form -->
</form>
```

By default, this will automatically intercept form submission, optimize your file input(s), and then resubmit the form with optimized video(s).

(So it can run before [Active Storage Direct Upload](https://guides.rubyonrails.org/active_storage_overview.html#direct-uploads) handles the document's submit event, the `straight-to-video` controller binds to the _window_'s submit event.)

If you want to get a jump on things, you can also wire up the change event to optimize as soon as the user sets the file, so it's ready to upload as soon as submitted:

```html
<input data-straight-to-video-target="fileInput" type="file"
  data-action="change->straight-to-video#change">
```

And if you have another controller that's interested in displaying progress of optimization or surfacing any errors, you can also bind to the controller's events:

* `progress` - fired as optimization proceeds—this event's `detail` contains `{ progress }` as an integer percent completion
* `done` - fired after optimization finishes, with `detail` containing a boolean `{ changed }`, indicating whether the file was optimized and swapped out
* `error` - fired when optimization encounters an error, with `detail` containing `{ error }` of the originating error

These might be wired up in the same form like this:

```html
<form data-controller="straight-to-video progress-bar">
  <input data-straight-to-video-target="fileInput" type="file"
    data-action="change->straight-to-video#change
      straight-to-video:progress->progress-bar#update
      straight-to-video:done->progress-bar#finish">

  <!-- The rest of your form -->
</form>
```

## Import maps

Pin the library and (only if using the controller) Stimulus:

Rails (config/importmap.rb):

```ruby
pin "straight-to-video", to: "https://unpkg.com/straight-to-video@0.0.1/index.js"
pin "@hotwired/stimulus", to: "https://cdn.jsdelivr.net/npm/@hotwired/stimulus/+esm"
```

Plain HTML:

```html
<script type="importmap">
{
  "imports": {
    "straight-to-video": "https://unpkg.com/straight-to-video@0.0.1/index.js",
    "@hotwired/stimulus": "https://cdn.jsdelivr.net/npm/@hotwired/stimulus/+esm",
    "mediabunny": "https://cdn.jsdelivr.net/npm/mediabunny/+esm"
  }
}
</script>
```

Then in your bootstrap code:

```js
import { registerStraightToVideoController } from 'straight-to-video'
import { Application, Controller } from '@hotwired/stimulus'

const app = Application.start()
registerStraightToVideoController(app, { Controller })
```

<p align="center">
  <img width="480" align="center" src="assets/img/logo.webp" alt="straight-to-video VHS Logo">
  <br>
  Check out the <a href="https://searlsco.github.io/straight-to-video/">interactive demo page</a>!
</p>

# straight-to-video

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

`straight-to-video` optimizes video entirely in the browser using [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API). Files are remuxed & re-encoded to meet the requirements of the [Instagram API](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media#video-specifications), which is as good a lowest-common-denominator as any.

I'm not here to save the planet—I wrote this because I'm cheap and I was sick of waiting all day to upload 4K videos to [my Rails app](https://beckygram.com), only to have to [pay Heroku tooth-and-nail](https://judoscale.com/blog/priced-out-of-heroku) to transcode those videos for me. That said, **if everyone were to plug this into their HTML forms tomorrow, it'd save users and developers a gobsmacking amount of bandwidth and server costs.**

Seriously, most off-iPhone videos are **in the neighborhood of 90-95% smaller after running through `straight-to-video` optimization**, sometimes shaving tens of minutes from the time it would take to upload at 30 Mbps.

## Install

You can find [straight-to-video on npm](https://www.npmjs.com/package/straight-to-video) and its

```
npm install straight-to-video
```

Or if you're one of us Ruby on Rails weirdos:

```
bin/importmap pin straight-to-video
```

## API

### canOptimizeVideo

`canOptimizeVideo(file)` quickly validates that a `File` is a recognizable video and that the browser can encode it with WebCodecs. It does not perform any heavy work and does not estimate output size.

Returns an object with three fields only: `{ ok, reason, message }`.

```js
import { canOptimizeVideo } from 'straight-to-video'

const result = await canOptimizeVideo(file)
// Example results:
// { ok: true,  reason: 'ok', message: 'ok' }
// { ok: false, reason: 'probe-failed', message: '…error message…' }
```

### optimizeVideo

`optimizeVideo(file)` will run your file through [this AI-generated fever dream](/index.js) and it'll return a version that's downscaled to 1080p and ready to share, whether it needs to be remuxed, transcoded, or have a silent AAC track injected.

The method will generally fail silently without changing the file (worst-case, I just let users upload the same garbage to my server they always have).

```
import { optimizeVideo } from 'straight-to-video'

const result = await optimizeVideo(file)
// Example results:
// { changed: true,  file: File('my-clip-optimized.mp4') }
// { changed: false, file: File('image.png') }
```

### registerStraightToVideoController

If you're looking to rig `straight-to-video` up with Stimulus, you can register the included controller by passing your Stimulus app and the `Controller` parent class to `registerStraightToVideoController`:

```js
import { Application, Controller } from '@hotwired/stimulus'
import { registerStraightToVideoController } from 'straight-to-video'

const app = Application.start()
registerStraightToVideoController(app, { Controller })
```

This will register a controller named `"straight-to-video"` that will target one or more file inputs and handle video optimization during form submission.

More on that in the next section.

## Integrating with Stimulus

I wrote `straight-to-video` to support video workflows for a [couple](https://www.betterwithbecky.com) Rails [apps](https://posseparty.com/). Both apps use [import maps](https://guides.rubyonrails.org/working_with_javascript_in_rails.html#choosing-between-import-maps-and-a-javascript-bundler) and [Stimulus](https://stimulus.hotwired.dev), so the controller that's bundled with this package is how I use `straight-to-video` myself.

Here's how to configure it if you have a similar setup.

```js
// app/javascript/controllers/index.js
import { application } from 'controllers/application'
import { Controller } from '@hotwired/stimulus'
import { registerStraightToVideoController } from 'straight-to-video'

registerStraightToVideoController(application, { Controller })
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

## Development

If you want to work on this code, install [ffmpeg](https://ffmpeg.org) and the dependencies:

```
brew install ffmpeg
npm install
```

You can run the tests (which run against both webkit and Chrome) with:

```
# Open graphical browsers
./script/test

# Run headlessly
CI=true ./script/test
```

You can run the server at [localhost:8080](http://localhost:8080) (which hosts the demo site) with:

```
npm run dev
```

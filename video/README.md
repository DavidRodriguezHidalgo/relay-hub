# The README video

Built with [Remotion](https://www.remotion.dev). It lives outside the pnpm workspace on purpose:
its dependencies are installed with npm into `video/node_modules`, so the app's install, build,
tests and startup never see it.

```sh
cd video
npm install
npm run render   # writes out/relay-orchestration.mp4
npm run studio   # preview and scrub while editing
```

The palette is the app's own `apps/desktop/src/ui/theme.css`, imported directly, so the video
cannot drift into looking like a different product. The session names and text are invented but
generic; nothing here shows real work.

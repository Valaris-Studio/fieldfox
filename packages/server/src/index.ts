export { app, createApp } from './app.js';

// The app is a standard Hono instance; a Node/edge server adapter mounts
// `app.fetch`. The concrete Node listener (and its @hono/node-server dependency)
// lands with the config/deploy card — keeping index.ts side-effect-free means
// tests and embedders import the app without starting a server.

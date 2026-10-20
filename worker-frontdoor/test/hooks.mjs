// Lets plain Node load worker.js: "cloudflare:workers" resolves to a small stub.
import { register } from "node:module";
register("./loader.mjs", import.meta.url);

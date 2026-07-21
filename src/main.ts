import { mount } from "svelte";
import App from "./routes/App.svelte";
import { maybeInstallBridgeMock } from "./lib/mock/bridge-mock";
import "./app.css";

// Install the fake preload before the app mounts (no-op unless VITE_AMBIENT_MOCK=1
// and no real Electron preload is present).
maybeInstallBridgeMock();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;

import FormData from "react-native/Libraries/Network/FormData";

if (typeof globalThis.FormData === "undefined") {
  globalThis.FormData = FormData;
}

if (typeof globalThis.performance === "undefined") {
  globalThis.performance = {
    now: () => Date.now()
  };
} else if (typeof globalThis.performance.now !== "function") {
  globalThis.performance.now = () => Date.now();
}

const { registerRootComponent } = require("expo");
const TrackPlayer = require("react-native-track-player").default;
const App = require("./App").default;

TrackPlayer.registerPlaybackService(() => require("./src/lib/trackPlayerService").default);
registerRootComponent(App);

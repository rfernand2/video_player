// Bridge between the renderer (window.api) and the main process (main.js).
// To add a capability: handle a channel in main.js, expose it here.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, ...args) => callback(...args));
};

contextBridge.exposeInMainWorld('api', {
  // app
  pickVideo: invoke('app:pick-video'),           // () => path | null
  initialFile: invoke('app:initial-file'),       // () => path | null
  setFullscreen: invoke('app:set-fullscreen'),   // (on?: boolean) toggles when omitted
  pathForFile: (file) => webUtils.getPathForFile(file), // dropped File -> path
  onCommand: listen('command'),                  // (name) from the menu

  // media (all refer to the video last passed to openVideo)
  openVideo: invoke('media:open'),               // (path) => info
  frameTimes: invoke('media:frame-times'),       // () => Float64Array
  scanShots: invoke('media:scan-shots'),         // () => resolves when the whole file is scored
  onShotBatch: listen('shots:batch'),            // (videoId, times: Float64Array, scores: Float32Array)
  scrubAudio: invoke('media:scrub-audio'),       // () => { sampleRate, sampleCount } | null
  readAudio: invoke('media:read-audio'),         // (startSample, count) => Int16Array

  // notes
  readNotes: invoke('notes:read'),               // () => markdown | null
  writeNotes: invoke('notes:write'),             // (markdown)
  openNotes: invoke('notes:open'),               // () => opened?
  revealNotes: invoke('notes:reveal'),
});

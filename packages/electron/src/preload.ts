/**
 * Preload is intentionally empty for Phase 1 chase.
 * LTC uses Web Audio getUserMedia; MTC uses Web MIDI in the renderer —
 * both work in Electron Chromium without a native bridge. A preload bridge
 * can land later for exclusive device access or Windows MIDI ports.
 */
export {};

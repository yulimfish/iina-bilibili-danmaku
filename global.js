// global.js — app-level entry.
// Normal player instances own their sidebar and menu. IINA's global message
// API only targets plugin-managed players, so registering a global toggle here
// would create a misleading menu item for ordinary local-video windows.

const { console } = iina;
console.log("[bili-danmaku] global entry loaded");

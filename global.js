// global.js — app-level entry (M1 skeleton).
// Sidebar panels belong to main entries, so the global menu drives all
// player instances via global.postMessage. Keeps working with no video open.

const { console, menu, global } = iina;

const TAG = "[bili-danmaku]";
const TOGGLE_SIDEBAR = "bili-danmaku:toggle-sidebar";

const rootItem = menu.item("Bili Danmaku");
rootItem.addSubMenuItem(menu.item("Toggle Danmaku Panel", () => {
    console.log(TAG + " global toggle -> all players");
    global.postMessage(null, TOGGLE_SIDEBAR, null);
}));
menu.addItem(rootItem);

console.log(TAG + " global entry loaded");

// main.js — per-player entry (M1 skeleton).
// Owns: sidebar panel lifecycle, main-entry menu, toggle state.
// Bilibili fetching (M2/M3) and overlay rendering (M2/M4) plug in later.

const { console, menu, sidebar, global } = iina;

const TAG = "[bili-danmaku]";
const TOGGLE_SIDEBAR = "bili-danmaku:toggle-sidebar";

let sidebarVisible = false;

function showSidebar() {
    sidebar.show();
    sidebarVisible = true;
    console.log(TAG + " sidebar shown");
}

function hideSidebar() {
    sidebar.hide();
    sidebarVisible = false;
    console.log(TAG + " sidebar hidden");
}

function toggleSidebar() {
    if (sidebarVisible) {
        hideSidebar();
    } else {
        showSidebar();
    }
}

// Load the panel once per player instance.
sidebar.loadFile("sidebar/index.html");
console.log(TAG + " sidebar file loaded");

// Sidebar -> plugin handshake (M1: link check only, no logic yet).
sidebar.onMessage("sidebar-ready", () => {
    console.log(TAG + " sidebar ready");
    sidebar.postMessage("state", { loaded: false, status: "idle" });
});

// Main-entry menu (visible while this player window is focused).
const rootItem = menu.item("Bili Danmaku");
rootItem.addSubMenuItem(menu.item("Toggle Danmaku Panel", toggleSidebar));
menu.addItem(rootItem);

// Driven by the global entry menu when no player window has focus.
global.onMessage(TOGGLE_SIDEBAR, toggleSidebar);

console.log(TAG + " main entry loaded");

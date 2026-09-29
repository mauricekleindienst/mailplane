'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const nodeCrypto = require('crypto');
const { version: APP_VERSION } = require('./package.json');

// Explicit channel allowlists — nothing outside these lists can cross the boundary
const INVOKE_CHANNELS = new Set([
  'accounts:list', 'accounts:add', 'accounts:remove', 'accounts:update',
  'accounts:preset', 'accounts:autodiscover', 'accounts:test', 'accounts:folders', 'accounts:folders:all',
  'apps:list', 'apps:add', 'apps:remove',
  'emails:fetch', 'emails:search', 'emails:starred', 'accounts:quota',
  'email:body', 'email:send', 'email:delete', 'email:archive',
  'email:move', 'email:flag', 'email:markread', 'email:bulk', 'email:attachment',
  'email:bimi',
  'email:scheduled:list', 'email:scheduled:cancel', 'draft:save', 'draft:delete', 'email:snooze', 'email:snoozed:list', 'email:snoozed:wake',
  'folder:create', 'folder:rename', 'folder:delete',
  'shell:open',
  'update:install', 'update:check', 'update:info', 'update:download',
  'ai:status', 'ai:save', 'ai:models', 'ai:run',
  'app:integration',
  'caldav:test', 'caldav:add', 'caldav:remove', 'caldav:list', 'caldav:calendars', 'caldav:events',
]);

const SEND_CHANNELS = new Set([
  'badge:set',
  'context-menu:show',
  'context-menu:folder',
  'context-menu:account',
  'prefs:notify',
  'titlebar:theme',
  'update:config',
  'window:translucent',
]);

const RECEIVE_CHANNELS = new Set([
  'new-emails', 'mailto', 'update-ready', 'email:scheduled:fired', 'email:unsnoozed', 'notification-reply',
  'open-settings', 'new-message', 'reply', 'reply-all', 'forward',
  'refresh', 'delete-email', 'archive-email', 'mark-read', 'toggle-star',
  'context-menu:action', 'context-menu:folder-action', 'context-menu:account-action',
  'fullscreen-change',
  'emails:refreshed',
  'update:status',
  'toggle-sidebar', 'toggle-list', 'open-search', 'notification-open',
]);

contextBridge.exposeInMainWorld('electronAPI', {
  /** Invoke a main-process handler and get a response. */
  invoke(channel, data) {
    if (!INVOKE_CHANNELS.has(channel)) {
      throw new Error(`[preload] Blocked invoke on unlisted channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, data);
  },

  /** Fire-and-forget send to main process. */
  send(channel, data) {
    if (!SEND_CHANNELS.has(channel)) {
      throw new Error(`[preload] Blocked send on unlisted channel: ${channel}`);
    }
    ipcRenderer.send(channel, data);
  },

  /**
   * Subscribe to a channel from main. Returns a cleanup function.
   * The callback receives the payload args directly (no event object).
   */
  on(channel, callback) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      throw new Error(`[preload] Blocked receive on unlisted channel: ${channel}`);
    }
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /** MD5 hex digest — required for Gravatar URLs (must stay in main world). */
  md5(str) {
    return nodeCrypto.createHash('md5').update(str).digest('hex');
  },

  /** App version from package.json — exposed so renderer can display it. */
  appVersion: APP_VERSION,
  // File.path is gone since Electron 32 — this is its replacement
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },

  /** OS the window chrome is laid out for ('darwin' | 'win32' | 'linux'). */
  platform: process.env.MAILPLANE_PLATFORM || process.platform,
  /** Whether the window can show the desktop through (macOS vibrancy, Windows acrylic). */
  canTranslucent: process.platform === 'darwin' || process.platform === 'win32',
});

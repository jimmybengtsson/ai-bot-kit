// src/utils/runtimeId.js — Shared id generation helper for persistent runtime records.

export function makeRuntimeId(prefix = '') {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return prefix ? `${String(prefix).trim()}_${id}` : id;
}

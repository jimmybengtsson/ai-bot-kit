// src/utils/runtimeTime.js — Shared time helpers for runtime stores and audit layers.

export function nowIso() {
  return new Date().toISOString();
}

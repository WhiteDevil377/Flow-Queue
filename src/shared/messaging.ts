import type { RuntimeRequest, RuntimeResponse } from "./types";

export function sendRuntimeMessage<T = unknown>(message: RuntimeRequest): Promise<RuntimeResponse<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message || "Runtime message failed" });
      } else {
        resolve(response ?? { success: true });
      }
    });
  });
}

export async function sendTabMessage<T = unknown>(
  tabId: number,
  message: RuntimeRequest
): Promise<RuntimeResponse<T>> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message || "Tab message failed" });
      } else {
        resolve(response ?? { success: true });
      }
    });
  });
}

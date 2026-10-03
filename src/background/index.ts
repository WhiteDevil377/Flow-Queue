import { flowSelectors } from "../shared/selectors";
import type { FlowLogEntry, RuntimeRequest, VideoResourceCandidate } from "../shared/types";

let downloadFolder = "";
let downloadPrefix = "";
let shouldRenameDownloads = true;
const explicitDownloadNames = new Map<string, string>();
const expectedFlowDownloads = new Map<string, ExpectedFlowDownload>();
const attachedTabs = new Set<number>();
const recentVideoUrlsByTab = new Map<number, VideoResourceCandidate[]>();
const networkRequestsByTab = new Map<number, Map<string, NetworkRequestInfo>>();
const flowTabUrlPatterns = ["*://flow.google.com/*", "*://labs.google/*"];
const flowCookieDomains = ["flow.google.com", "labs.google"];
const flowStorageOrigins = ["https://flow.google.com", "https://labs.google"];

interface ExpectedFlowDownload {
  expectationId: string;
  finalName?: string;
  downloadId?: number;
  settled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: { downloadId: number; state: "complete" }) => void;
  reject: (error: Error) => void;
  promise: Promise<{ downloadId: number; state: "complete" }>;
}

interface NetworkRequestInfo {
  requestId: string;
  url: string;
  resourceType?: string;
  mimeType?: string;
}

interface NetworkRequestWillBeSentParams {
  requestId?: string;
  type?: string;
  request?: {
    url?: string;
  };
}

interface NetworkResponseReceivedParams {
  requestId?: string;
  type?: string;
  response?: {
    url?: string;
    mimeType?: string;
    headers?: Record<string, unknown>;
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await enableSidePanel();
  await reloadFlowTabs();
});

chrome.runtime.onStartup.addListener(enableSidePanel);

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    await enableSidePanel();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  recentVideoUrlsByTab.delete(tabId);
  networkRequestsByTab.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    recentVideoUrlsByTab.delete(source.tabId);
    networkRequestsByTab.delete(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attachedTabs.has(source.tabId)) return;
  if (method === "Network.requestWillBeSent") {
    recordNetworkRequest(source.tabId, params as NetworkRequestWillBeSentParams);
  } else if (method === "Network.responseReceived") {
    recordNetworkResponse(source.tabId, params as NetworkResponseReceivedParams);
  } else if (method === "Network.loadingFinished") {
    void scanNetworkResponseBody(source.tabId, params as { requestId?: string });
  }
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const expectedDownload = claimExpectedFlowDownload(downloadItem.id, downloadItem);
  if (expectedDownload?.finalName) {
    suggest({ filename: expectedDownload.finalName });
    return;
  }

  const isFlowDownload = isFlowResource(downloadItem.url, downloadItem.filename);
  if (!isFlowDownload) {
    return;
  }

  const explicitName = explicitDownloadNames.get(downloadItem.url);
  if (explicitName) {
    explicitDownloadNames.delete(downloadItem.url);
    suggest({ filename: explicitName });
    return;
  }

  if (!shouldRenameDownloads) {
    return;
  }

  const original = (downloadItem.filename || new URL(downloadItem.url).pathname.split("/").pop() || "flow-output").split("/").pop() || "flow-output";
  suggest({ filename: buildDownloadPath(downloadFolder, downloadPrefix, original) });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current) return;
  const expectedDownload = [...expectedFlowDownloads.values()].find((entry) => entry.downloadId === delta.id);
  if (!expectedDownload) return;
  if (delta.state.current === "complete") {
    finishExpectedFlowDownload(expectedDownload.expectationId, undefined, delta.id);
  } else if (delta.state.current === "interrupted") {
    finishExpectedFlowDownload(
      expectedDownload.expectationId,
      new Error(`Chrome download was interrupted${delta.error?.current ? `: ${delta.error.current}` : ""}`),
      delta.id
    );
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message: RuntimeRequest, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "GET_FLOW_SELECTORS":
      return { success: true, selectors: flowSelectors };
    case "SET_ZOOM":
      return setZoom(sender.tab?.id, message.zoomFactor);
    case "START_DOWNLOAD":
      return startDownload(message.url, message.filename, message.folder, message.filePrefix, message.autoChangeFileName);
    case "SET_DOWNLOAD_NAMING":
      return setDownloadNaming(message.folderName, message.filePrefix, message.autoChangeFileName);
    case "REGISTER_EXPECTED_FLOW_DOWNLOAD":
      return registerExpectedFlowDownload(message.expectationId, message.filename, message.folder, message.filePrefix, message.autoChangeFileName);
    case "WAIT_EXPECTED_FLOW_DOWNLOAD":
      return waitExpectedFlowDownload(message.expectationId, message.timeoutMs);
    case "CLEAR_EXPECTED_FLOW_DOWNLOAD":
      return clearExpectedFlowDownload(message.expectationId);
    case "CLEAR_FLOW_SESSION":
      return clearFlowSession(sender.tab?.id);
    case "GET_RECENT_VIDEO_URLS":
      return getRecentVideoUrls(sender.tab?.id, message.sinceMs);
    case "ATTACH_DEBUGGER":
      return attachDebugger(sender.tab?.id);
    case "DETACH_DEBUGGER":
      return detachDebugger(sender.tab?.id);
    case "INSERT_TEXT":
      return insertText(sender.tab?.id, message.text);
    case "SEND_KEY":
      return sendKey(sender.tab?.id, message.key, message.code, message.keyCode, message.modifiers);
    case "MOVE_MOUSE":
      return moveMouse(sender.tab?.id, message.x, message.y);
    case "CLICK_AT":
      return clickAt(sender.tab?.id, message.x, message.y);
    case "PROMPT_GROUP_UPDATE":
      await chrome.runtime.sendMessage(message).catch(() => undefined);
      return { success: true };
    case "LOG_EVENT":
      return recordLog(message.entry);
    case "GET_LOGS":
      return getLogs();
    case "CLEAR_LOGS":
      await chrome.storage.local.set({ flowQueueLogs: [] });
      await chrome.runtime.sendMessage({ type: "LOG_EVENT", entry: createBackgroundLog("info", "Logs cleared") }).catch(() => undefined);
      return { success: true };
    default:
      return { success: true };
  }
}

async function recordLog(entry: FlowLogEntry) {
  const stored = await chrome.storage.local.get("flowQueueLogs");
  const logs = Array.isArray(stored.flowQueueLogs) ? stored.flowQueueLogs as FlowLogEntry[] : [];
  const next = [...logs, entry].slice(-300);
  await chrome.storage.local.set({ flowQueueLogs: next });
  await chrome.runtime.sendMessage({ type: "LOG_EVENT", entry }).catch(() => undefined);
  return { success: true };
}

async function getLogs() {
  const stored = await chrome.storage.local.get("flowQueueLogs");
  return { success: true, logs: Array.isArray(stored.flowQueueLogs) ? stored.flowQueueLogs as FlowLogEntry[] : [] };
}

function getRecentVideoUrls(tabId: number | undefined, sinceMs = 0) {
  if (tabId === undefined) return { success: false, error: "No active Flow tab" };
  const urls = (recentVideoUrlsByTab.get(tabId) ?? [])
    .filter((entry) => entry.at >= sinceMs)
    .sort((a, b) => a.at - b.at);
  return { success: true, urls };
}

function recordNetworkRequest(tabId: number, params: NetworkRequestWillBeSentParams) {
  const requestId = params.requestId;
  const url = params.request?.url ?? "";
  if (!requestId || !url) return;
  const requests = networkRequestsByTab.get(tabId) ?? new Map<string, NetworkRequestInfo>();
  requests.set(requestId, { requestId, url, resourceType: params.type });
  networkRequestsByTab.set(tabId, requests);
  if (videoNetworkTargetLooksDownloadable(url, params.type)) {
    rememberVideoUrl(tabId, {
      url,
      at: Date.now(),
      source: "network-request",
      resourceType: params.type
    });
  }
}

function recordNetworkResponse(tabId: number, params: NetworkResponseReceivedParams) {
  const requestId = params.requestId;
  const url = params.response?.url ?? "";
  const mimeType = params.response?.mimeType;
  if (requestId) {
    const requests = networkRequestsByTab.get(tabId) ?? new Map<string, NetworkRequestInfo>();
    const existing = requests.get(requestId);
    requests.set(requestId, {
      requestId,
      url: url || existing?.url || "",
      resourceType: params.type ?? existing?.resourceType,
      mimeType
    });
    networkRequestsByTab.set(tabId, requests);
  }
  if (url && videoNetworkTargetLooksDownloadable(url, params.type, mimeType, params.response?.headers)) {
    rememberVideoUrl(tabId, {
      url,
      at: Date.now(),
      source: "network-response",
      mimeType,
      resourceType: params.type
    });
  }
}

async function scanNetworkResponseBody(tabId: number, params: { requestId?: string }) {
  const requestId = params.requestId;
  if (!requestId) return;
  const requestInfo = networkRequestsByTab.get(tabId)?.get(requestId);
  if (!requestInfo || !networkResponseBodyCouldContainMediaUrl(requestInfo)) return;
  try {
    const response = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }) as {
      body?: string;
      base64Encoded?: boolean;
    };
    const rawBody = response.body ?? "";
    if (!rawBody) return;
    const body = response.base64Encoded ? atob(rawBody) : rawBody;
    for (const { url, context } of extractVideoUrlsFromText(body)) {
      rememberVideoUrl(tabId, {
        url,
        at: Date.now(),
        source: "network-body",
        mimeType: requestInfo.mimeType,
        resourceType: requestInfo.resourceType,
        context
      });
    }
  } catch {
    // Some streaming/media responses do not expose a readable body through CDP.
  } finally {
    networkRequestsByTab.get(tabId)?.delete(requestId);
  }
}

function networkResponseBodyCouldContainMediaUrl(request: NetworkRequestInfo) {
  const target = `${request.url} ${request.resourceType ?? ""} ${request.mimeType ?? ""}`;
  if (/\.(?:png|jpe?g|gif|webp|bmp|css|js|woff2?|ico)(?:[?#]|$)/i.test(request.url)) return false;
  return /flow\.google\.com|labs\.google|googleapis|googleusercontent|googlevideo|storage\.googleapis|json|xhr|fetch|document|script/i.test(target);
}

function extractVideoUrlsFromText(text: string) {
  const normalized = normalizeEscapedUrlText(text);
  const decoded = safelyDecodeUrlText(normalized);
  return uniqueStrings([normalized, decoded])
    .flatMap((body) => extractAbsoluteUrls(body).map((url) => ({
      url,
      context: contextForUrl(body, url)
    })))
    .filter(({ url, context }) => videoNetworkTargetLooksDownloadable(url, undefined, undefined, undefined, context));
}

function normalizeEscapedUrlText(value: string) {
  return value
    .replace(/\\u003a/gi, ":")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u003f/g, "?")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function safelyDecodeUrlText(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractAbsoluteUrls(text: string) {
  return (text.match(/(?:https?:)?\/\/[^"' <>)\\]+/g) ?? [])
    .map((url) => trimUrl(url.startsWith("//") ? `https:${url}` : url));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function trimUrl(url: string) {
  return url.replace(/[),.;]+$/g, "");
}

function contextForUrl(text: string, url: string) {
  const start = text.indexOf(url);
  if (start < 0) return "";
  return text.slice(Math.max(0, start - 3000), start + url.length + 3000);
}

function rememberVideoUrl(tabId: number, entry: VideoResourceCandidate) {
  const current = recentVideoUrlsByTab.get(tabId) ?? [];
  if (!current.some((candidate) => candidate.url === entry.url)) {
    current.push(entry);
  }
  const cutoff = Date.now() - 30 * 60 * 1000;
  recentVideoUrlsByTab.set(tabId, current.filter((candidate) => candidate.at >= cutoff).slice(-200));
}

function videoNetworkTargetLooksDownloadable(
  url: string,
  resourceType?: string,
  mimeType?: string,
  headers?: Record<string, unknown>,
  context = ""
) {
  if (!url || imageDownloadPattern().test(url) || nonDownloadableVideoResourceUrl(url)) return false;
  const headerText = headers ? Object.entries(headers).map(([key, value]) => `${key}:${String(value)}`).join(" ") : "";
  const responseMetadata = `${resourceType ?? ""} ${mimeType ?? ""} ${headerText}`;
  const urlLooksDirectVideo = /^blob:/i.test(url) || /\.mp4(?:[?#]|$|\s)|\.webm(?:[?#]|$|\s)|\.mov(?:[?#]|$|\s)|videoplayback/i.test(url);
  const urlLooksSignedVideo = flowVideoResourceHostLooksPossible(url) && /alt=media|response-content-type=video|x-goog-signature|x-goog-credential|x-goog-algorithm|googleaccessid|signature=|token=|download|video|media/i.test(url);
  const mimeLooksVideo = /video\/(?:mp4|webm|quicktime|x-matroska|mpeg)|application\/octet-stream/i.test(responseMetadata);
  const sourceLooksMedia = /\bmedia\b/i.test(resourceType ?? "");
  const hostLooksFlowMedia = flowVideoResourceHostLooksPossible(url);
  const nearbyContextLooksVideo = /video(?:Url|_url|Uri|_uri|\/mp4|\/webm|\/quicktime)|media(?:Url|_url|Uri|_uri)|download(?:Url|_url|Uri|_uri)|mimeType["':\s]+video|\.(?:mp4|webm|mov)(?:[?#"' <>)\\]|$)/i.test(context);
  return urlLooksDirectVideo || urlLooksSignedVideo || mimeLooksVideo || (sourceLooksMedia && hostLooksFlowMedia) || (hostLooksFlowMedia && nearbyContextLooksVideo);
}

function flowVideoResourceHostLooksPossible(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return /(?:^|\.)googleusercontent\.com$|(?:^|\.)googlevideo\.com$|(?:^|\.)googleapis\.com$|(?:^|\.)storage\.googleapis\.com$|(?:^|\.)firebasestorage\.googleapis\.com$|(?:^|\.)gvt\d?\.com$|^flow\.google\.com$|^labs\.google$/i.test(hostname);
  } catch {
    return /^blob:|videoplayback/i.test(url);
  }
}

function nonDownloadableVideoResourceUrl(url: string) {
  if (!url || url.startsWith("data:")) return true;
  return /(?:^|[/?#&=._-])(?:manifest|playlist|dash|hls)(?:[/?#&=._-]|$)/i.test(url) ||
    /\.(?:xml|m3u8|mpd|json|txt|html?|css|js|wasm|map|svg|ico)(?:[?#]|$)/i.test(url);
}

function createBackgroundLog(level: FlowLogEntry["level"], message: string): FlowLogEntry {
  return {
    id: `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    level,
    source: "background",
    message
  };
}

async function enableSidePanel() {
  try {
    const path = chrome.runtime.getManifest().side_panel?.default_path || "src/sidepanel/index.html";
    await chrome.sidePanel.setOptions({ path, enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Chrome exposes sidePanel only in supported browser versions.
  }
}

async function reloadFlowTabs() {
  const tabs = await chrome.tabs.query({ url: flowTabUrlPatterns });
  await Promise.all(
    tabs
      .filter((tab) => tab.id !== undefined && isFlowUrl(tab.url))
      .map((tab) => chrome.tabs.reload(tab.id!).catch(() => undefined))
  );
}

async function setZoom(tabId: number | undefined, zoomFactor: number) {
  if (tabId === undefined) return { success: false, error: "No active Flow tab" };
  await chrome.tabs.setZoom(tabId, zoomFactor);
  return { success: true };
}

async function startDownload(url: string, filename?: string, folder?: string, filePrefix?: string, autoChangeFileName = true) {
  const safeFolder = sanitizePath(folder || "");
  const safeFile = filename ? sanitizeFilename(filename) : undefined;
  const safePrefix = sanitizeFilename(filePrefix ?? downloadPrefix, true);
  const finalName = safeFile ? buildDownloadPath(safeFolder, safePrefix, safeFile) : undefined;

  if (autoChangeFileName && finalName) {
    explicitDownloadNames.set(url, finalName);
  }

  const downloadId = await chrome.downloads.download({
    url,
    filename: autoChangeFileName ? finalName : undefined,
    saveAs: false
  });
  const state = await waitForDownloadComplete(downloadId);
  return { success: true, downloadId, state };
}

function registerExpectedFlowDownload(expectationId: string, filename?: string, folder?: string, filePrefix?: string, autoChangeFileName = true) {
  clearExpectedFlowDownload(expectationId);
  const safeFolder = sanitizePath(folder || "");
  const safeFile = filename ? sanitizeFilename(filename) : undefined;
  const safePrefix = sanitizeFilename(filePrefix ?? downloadPrefix, true);
  const finalName = autoChangeFileName && safeFile ? buildDownloadPath(safeFolder, safePrefix, safeFile) : undefined;
  let resolve!: ExpectedFlowDownload["resolve"];
  let reject!: ExpectedFlowDownload["reject"];
  const promise = new Promise<{ downloadId: number; state: "complete" }>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  const entry: ExpectedFlowDownload = {
    expectationId,
    finalName,
    resolve,
    reject,
    promise
  };
  expectedFlowDownloads.set(expectationId, entry);
  return { success: true };
}

async function waitExpectedFlowDownload(expectationId: string, timeoutMs = 90 * 1000) {
  const entry = expectedFlowDownloads.get(expectationId);
  if (!entry) return { success: false, error: "Expected Flow download was not registered." };
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    finishExpectedFlowDownload(expectationId, new Error("Flow download did not start or finish in time."));
  }, timeoutMs);

  if (entry.downloadId !== undefined) {
    const item = (await chrome.downloads.search({ id: entry.downloadId }))[0];
    if (item?.state === "complete") {
      finishExpectedFlowDownload(expectationId, undefined, entry.downloadId);
    } else if (item?.state === "interrupted") {
      finishExpectedFlowDownload(expectationId, new Error(`Chrome download was interrupted${item.error ? `: ${item.error}` : ""}`), entry.downloadId);
    }
  }

  try {
    const result = await entry.promise;
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function clearExpectedFlowDownload(expectationId: string) {
  const entry = expectedFlowDownloads.get(expectationId);
  if (entry?.timer) clearTimeout(entry.timer);
  expectedFlowDownloads.delete(expectationId);
  return { success: true };
}

function claimExpectedFlowDownload(downloadId: number, downloadItem: chrome.downloads.DownloadItem) {
  const entry = [...expectedFlowDownloads.values()]
    .find((candidate) => !candidate.settled && candidate.downloadId === undefined && expectedFlowDownloadMatches(candidate, downloadItem));
  if (!entry) return null;
  entry.downloadId = downloadId;
  return entry;
}

function expectedFlowDownloadMatches(entry: ExpectedFlowDownload, downloadItem: chrome.downloads.DownloadItem) {
  if (!isLikelyFlowDownloadItem(downloadItem)) return false;
  const expectsVideo = /\.(mp4|webm|mov)$/i.test(entry.finalName || "");
  if (!expectsVideo) return true;
  return isVideoDownloadItem(downloadItem) && !isImageDownloadItem(downloadItem);
}

function isLikelyFlowDownloadItem(downloadItem: chrome.downloads.DownloadItem) {
  const target = downloadItemTarget(downloadItem);
  return /flow\.google\.com|labs\.google|googleusercontent|usercontent|google/i.test(target);
}

function isVideoDownloadItem(downloadItem: chrome.downloads.DownloadItem) {
  if ([downloadItem.url, downloadItem.finalUrl].filter(Boolean).some((url) => nonDownloadableVideoResourceUrl(url))) return false;
  const target = [downloadItem.url, downloadItem.finalUrl, downloadItem.mime].filter(Boolean).join(" ");
  return /blob:|video|\.mp4(?:[?#]|$|\s)|\.webm(?:[?#]|$|\s)|\.mov(?:[?#]|$|\s)|alt=media|response-content-type=video|x-goog-signature|x-goog-credential|x-goog-algorithm|googleaccessid|signature=|token=|download|media/i.test(target);
}

function isImageDownloadItem(downloadItem: chrome.downloads.DownloadItem) {
  return imageDownloadPattern().test(downloadItemTarget(downloadItem));
}

function imageDownloadPattern() {
  return /image\/|\.jpe?g(?:[?#]|$|\s)|\.png(?:[?#]|$|\s)|\.gif(?:[?#]|$|\s)|\.webp(?:[?#]|$|\s)|\.bmp(?:[?#]|$|\s)|\.jfif(?:[?#]|$|\s)/i;
}

function downloadItemTarget(downloadItem: chrome.downloads.DownloadItem) {
  return [
    downloadItem.url,
    downloadItem.finalUrl,
    downloadItem.filename,
    downloadItem.mime
  ].filter(Boolean).join(" ");
}

function finishExpectedFlowDownload(expectationId: string, error?: Error, downloadId?: number) {
  const entry = expectedFlowDownloads.get(expectationId);
  if (!entry) return;
  if (entry.settled) return;
  entry.settled = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => expectedFlowDownloads.delete(expectationId), 60 * 1000);
  if (error) {
    entry.reject(error);
  } else {
    entry.resolve({ downloadId: downloadId ?? entry.downloadId ?? -1, state: "complete" });
  }
}

function waitForDownloadComplete(downloadId: number, timeoutMs = 12 * 60 * 1000) {
  return new Promise<"complete">((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve("complete");
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state?.current) return;
      if (delta.state.current === "complete") finish();
      if (delta.state.current === "interrupted") {
        finish(new Error(`Chrome download was interrupted${delta.error?.current ? `: ${delta.error.current}` : ""}`));
      }
    };
    const timer = setTimeout(() => {
      finish(new Error("Chrome download did not finish before timeout"));
    }, timeoutMs);

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const item = items[0];
      if (!item) return;
      if (item.state === "complete") finish();
      if (item.state === "interrupted") {
        finish(new Error(`Chrome download was interrupted${item.error ? `: ${item.error}` : ""}`));
      }
    });
  });
}

function setDownloadNaming(folderName?: string, filePrefix?: string, autoChangeFileName?: boolean) {
  if (folderName !== undefined) downloadFolder = sanitizePath(folderName);
  if (filePrefix !== undefined) downloadPrefix = sanitizeFilename(filePrefix, true);
  if (autoChangeFileName !== undefined) shouldRenameDownloads = autoChangeFileName;
  return { success: true };
}

function buildDownloadPath(folder: string, prefix: string, filename: string) {
  const safeFolder = sanitizePath(folder);
  const safePrefix = sanitizeFilename(prefix, true);
  const safeFile = sanitizeFilename(filename);
  return `${safeFolder ? `${safeFolder}/` : ""}${safePrefix}${safeFile}`;
}

async function clearFlowSession(tabId: number | undefined) {
  const authCookiePrefixes = ["__Secure", "SID", "SSID", "HSID", "APISID", "SAPISID", "LSID", "NID", "1P_JAR"];
  const cookies = (await Promise.all(flowCookieDomains.map((domain) => chrome.cookies.getAll({ domain })))).flat();
  await Promise.all(
    cookies
      .filter((cookie) => !authCookiePrefixes.some((prefix) => cookie.name.startsWith(prefix)))
      .map((cookie) =>
        chrome.cookies.remove({
          url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
          name: cookie.name
        })
      )
  );

  if (tabId !== undefined) {
    await attachDebugger(tabId);
    await Promise.all(flowStorageOrigins.map((origin) =>
      chrome.debugger.sendCommand({ tabId }, "Storage.clearDataForOrigin", {
        origin,
        storageTypes: "local_storage,cache_storage,indexeddb,websql,service_workers"
      }).catch(() => undefined)
    ));
  }

  return { success: true };
}

async function attachDebugger(tabId: number | undefined) {
  if (tabId === undefined) return { success: false, error: "No active Flow tab" };
  if (!attachedTabs.has(tabId)) {
    await recordLog(createBackgroundLog("debug", `Attaching debugger to tab ${tabId}`)).catch(() => undefined);
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already attached")) throw error;
    }
    attachedTabs.add(tabId);
  }
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
  await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", { cacheDisabled: true });
  return { success: true };
}

async function detachDebugger(tabId: number | undefined) {
  if (tabId === undefined) return { success: false, error: "No active Flow tab" };
  if (attachedTabs.has(tabId)) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    attachedTabs.delete(tabId);
  }
  return { success: true };
}

async function insertText(tabId: number | undefined, text: string) {
  const attached = await attachDebugger(tabId);
  if (!attached.success || tabId === undefined) return attached;
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
  return { success: true };
}

async function sendKey(tabId: number | undefined, key: string, code: string, keyCode: number, modifiers = 0) {
  const attached = await attachDebugger(tabId);
  if (!attached.success || tabId === undefined) return attached;
  const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
  return { success: true };
}

async function moveMouse(tabId: number | undefined, x: number, y: number) {
  const attached = await attachDebugger(tabId);
  if (!attached.success || tabId === undefined) return attached;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  return { success: true };
}

async function clickAt(tabId: number | undefined, x: number, y: number) {
  const attached = await attachDebugger(tabId);
  if (!attached.success || tabId === undefined) return attached;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return { success: true };
}

function isFlowResource(url: string, filename?: string) {
  const target = `${url} ${filename || ""}`;
  if (videoNetworkTargetLooksDownloadable(url)) return true;
  return /google/i.test(url) && /\.(mp4|webm|mov|jpg|jpeg|png|gif|webp|bmp|jfif)(\?|$|\s)/i.test(target);
}

function isFlowUrl(url?: string) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "flow.google.com" || (parsed.hostname === "labs.google" && parsed.href.includes("flow"));
  } catch {
    return false;
  }
}

function sanitizePath(value: string) {
  return value
    .trim()
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean)
    .join("/");
}

function sanitizeFilename(value: string, allowEmpty = false) {
  // eslint-disable-next-line no-control-regex
  const sanitized = value.trim().replace(/[<>:"\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 120);
  return sanitized || (allowEmpty ? "" : "flow-output");
}

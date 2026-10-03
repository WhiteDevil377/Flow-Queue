import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Bug,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FilePlus2,
  Image as ImageIcon,
  ImagePlus,
  ListChecks,
  Moon,
  Pencil,
  Play,
  RefreshCcw,
  Settings,
  Square,
  Star,
  Sun,
  Trash2,
  Video,
  XCircle,
} from "lucide-react";
import { sendRuntimeMessage, sendTabMessage } from "../shared/messaging";
import { languageDirection, normalizeLanguageCode, supportedLanguages, translate, type LanguageCode } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  type AutomationSettings,
  type FlowLogEntry,
  type PreparedImage,
  type PromptGroup,
  type PromptMode,
  type PromptPayload,
  type PromptResult,
  type RuntimeRequest
} from "../shared/types";
import "./styles.css";

const modes: Array<{ value: PromptMode; labelKey: "textToVideo" | "imageToVideo" | "textToImage" | "imageToImage" }> = [
  { value: "text-to-video", labelKey: "textToVideo" },
  { value: "image-to-video", labelKey: "imageToVideo" },
  { value: "text-to-image", labelKey: "textToImage" },
  { value: "image-to-image", labelKey: "imageToImage" }
];

const aspectOptions = [
  { value: "16:9", label: "16:9" },
  { value: "4:3", label: "4:3" },
  { value: "1:1", label: "1:1" },
  { value: "3:4", label: "3:4" },
  { value: "9:16", label: "9:16" }
];

const videoAspectOptions = [
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" }
];

const outputOptions = [1, 2, 3, 4].map((value) => ({ value, label: `${value}x` }));

const imageModelOptions = [
  { value: "Nano Banana 2", label: "Nano Banana 2" },
  { value: "Nano Banana Pro", label: "Nano Banana Pro" },
  { value: "Nano Banana 2 Lite", label: "Nano Banana 2 Lite" }
];

const videoModelOptions = [
  { value: "Omni 1.1 Flash", label: "Omni 1.1 Flash" },
  { value: "Veo 3.1 - Lite", label: "Veo 3.1 - Lite" },
  { value: "Veo 3.1 - Fast", label: "Veo 3.1 - Fast" },
  { value: "Veo 3.1 - Quality", label: "Veo 3.1 - Quality" }
];

const durationOptions = ["4s", "6s", "8s", "10s"].map((value) => ({ value, label: value }));

const mediaRequiredModes: PromptMode[] = ["image-to-video", "image-to-image"];
const reviewStatsStorageKey = "flowQueueReviewStats";
const reviewPromptThreshold = 7;
const reviewPromptCooldownMs = 14 * 24 * 60 * 60 * 1000;
const chromeWebStoreReviewUrl = "https://chromewebstore.google.com/detail/flow-queue-auto-veo-nano/jgfmgcoonfeifpbaciimdjeldpmjgoli";

interface ReviewStats {
  successfulRuns: number;
  promptedAt?: number;
  dismissedUntil?: number;
  reviewed?: boolean;
}

type PromptImageSelection = string[] | null;

function App() {
  const refreshTimer = useRef<number | null>(null);
  const reviewCountedGroups = useRef<Set<string>>(new Set());
  const [settings, setSettings] = useState<AutomationSettings>(DEFAULT_SETTINGS);
  const [mode, setMode] = useState<PromptMode>(DEFAULT_SETTINGS.defaultMode);
  const [prompts, setPrompts] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [defaultImageIds, setDefaultImageIds] = useState<string[]>([]);
  const [defaultNoImage, setDefaultNoImage] = useState(false);
  const [promptImageSelections, setPromptImageSelections] = useState<Record<number, PromptImageSelection>>({});
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [isFlowPage, setIsFlowPage] = useState(false);
  const [groups, setGroups] = useState<PromptGroup[]>([]);
  const [message, setMessage] = useState("");
  const [logs, setLogs] = useState<FlowLogEntry[]>([]);
  const [darkMode, setDarkMode] = useState(false);
  const [appearanceLoaded, setAppearanceLoaded] = useState(false);
  const [language, setLanguage] = useState<LanguageCode>(() => normalizeLanguageCode(chrome.i18n?.getUILanguage?.() || navigator.language));
  const [reviewStats, setReviewStats] = useState<ReviewStats>({ successfulRuns: 0 });
  const [reviewStatsLoaded, setReviewStatsLoaded] = useState(false);
  const [failedPromptEdits, setFailedPromptEdits] = useState<Record<string, string>>({});
  const languageRef = useRef(language);
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(language, key, values);

  useEffect(() => {
    loadSettings();
    loadAppearance();
    loadLanguage();
    loadReviewStats();
    loadLogs();
    refreshTabState();
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    const scheduleRefresh = (delayMs = 250) => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refreshTabState();
      }, delayMs);
    };
    const onActivated = () => scheduleRefresh(150);
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.active || isLikelyFlowUrl(changeInfo.url) || isLikelyFlowUrl(tab.url)) {
        scheduleRefresh(changeInfo.status === "complete" ? 250 : 900);
      }
    };
    const onFocusChanged = () => scheduleRefresh(250);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    void chrome.storage.local.set({ flowQueueSettings: settings });
  }, [settings]);

  useEffect(() => {
    if (appearanceLoaded) void chrome.storage.local.set({ flowQueueDarkMode: darkMode });
  }, [darkMode, appearanceLoaded]);

  useEffect(() => {
    languageRef.current = language;
    void chrome.storage.local.set({ flowQueueLanguage: language });
  }, [language]);

  const promptLines = useMemo(() => splitPrompts(prompts), [prompts]);
  const isRunning = groups.some((group) => group.status === "queued" || group.status === "running");
  const modeNeedsImages = mediaRequiredModes.includes(mode);
  const validationMessage = getValidationMessage(isFlowPage, promptLines.length, mode, images.length, isRunning, language);
  const canRun = !validationMessage;
  const latestGroup = groups[0];
  const visibleMessage = userVisibleMessage(message, language);
  const shouldShowReviewPrompt = reviewStatsLoaded &&
    reviewStats.successfulRuns >= reviewPromptThreshold &&
    !reviewStats.reviewed &&
    (!reviewStats.dismissedUntil || reviewStats.dismissedUntil <= Date.now());

  async function loadSettings() {
    const stored = await chrome.storage.local.get("flowQueueSettings");
    if (stored.flowQueueSettings) {
      const loaded = {
        ...DEFAULT_SETTINGS,
        ...stored.flowQueueSettings,
        download: { ...DEFAULT_SETTINGS.download, ...stored.flowQueueSettings.download }
      };
      if (loaded.promptDelaySecondsMin === 0 && loaded.promptDelaySecondsMax === 3) {
        loaded.promptDelaySecondsMin = DEFAULT_SETTINGS.promptDelaySecondsMin;
        loaded.promptDelaySecondsMax = DEFAULT_SETTINGS.promptDelaySecondsMax;
      }
      if (typeof stored.flowQueueSettings.download?.autoDownload !== "boolean") {
        loaded.download.autoDownload = loaded.download.videoQuality !== "no-download" || loaded.download.imageQuality !== "no-download";
      }
      if (stored.flowQueueSettings.defaultMode === "components-to-video") loaded.defaultMode = "image-to-video";
      if (loaded.imageModel === "Imagen" || loaded.imageModel.includes("Imagen 4")) loaded.imageModel = "Nano Banana 2 Lite";
      if (loaded.model === "Omni Flash") loaded.model = "Omni 1.1 Flash";
      if (!videoModelOptions.some((option) => option.value === loaded.model)) loaded.model = "Omni 1.1 Flash";
      setSettings(loaded);
      setMode(loaded.defaultMode ?? DEFAULT_SETTINGS.defaultMode);
    }
  }

  async function loadAppearance() {
    const stored = await chrome.storage.local.get("flowQueueDarkMode");
    if (typeof stored.flowQueueDarkMode === "boolean") setDarkMode(stored.flowQueueDarkMode);
    setAppearanceLoaded(true);
  }

  async function loadLanguage() {
    const stored = await chrome.storage.local.get("flowQueueLanguage");
    if (typeof stored.flowQueueLanguage === "string") setLanguage(normalizeLanguageCode(stored.flowQueueLanguage));
  }

  async function loadReviewStats() {
    const stored = await chrome.storage.local.get(reviewStatsStorageKey);
    setReviewStats(normalizeReviewStats(stored[reviewStatsStorageKey]));
    setReviewStatsLoaded(true);
  }

  function onRuntimeMessage(request: RuntimeRequest) {
    if (request.type === "PROMPT_GROUP_UPDATE") {
      setGroups((current) => [request.group, ...current.filter((item) => item.id !== request.group.id)].slice(0, 12));
      if (isSuccessfulPromptGroup(request.group)) recordSuccessfulRunForReview(request.group.id);
      const groupError = firstPromptGroupError(request.group);
      if (groupError && request.group.status === "error") setMessage(userVisibleMessage(groupError, languageRef.current));
    } else if (request.type === "LOG_EVENT") {
      setLogs((current) => {
        if (current.some((entry) => entry.id === request.entry.id)) return current;
        return [...current, request.entry].slice(-300);
      });
      const logMessage = userFacingLogMessage(request.entry, languageRef.current);
      if (logMessage) setMessage(logMessage);
    }
  }

  async function loadLogs() {
    const response = await sendRuntimeMessage<{ logs: FlowLogEntry[] }>({ type: "GET_LOGS" });
    if (response.success) setLogs(response.logs);
  }

  async function refreshTabState() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setActiveTabId(tab?.id ?? null);
    if (!tab?.id) {
      setIsFlowPage(false);
      return;
    }
    const response = await sendTabMessage<{ isFlowPage: boolean }>(tab.id, { type: "CHECK_FLOW_PAGE" });
    setIsFlowPage(Boolean((response.success && response.isFlowPage) || isLikelyFlowUrl(tab.url)));
  }

  async function openGoogleFlow() {
    const tab = await chrome.tabs.create({ url: "https://flow.google.com" });
    setActiveTabId(tab.id ?? null);
    setIsFlowPage(true);
    window.setTimeout(() => void refreshTabState(), 1000);
    window.setTimeout(() => void refreshTabState(), 3000);
    setMessage("");
  }

  function persistReviewStats(next: ReviewStats) {
    setReviewStats(next);
    void chrome.storage.local.set({ [reviewStatsStorageKey]: next });
  }

  function recordSuccessfulRunForReview(groupId: string) {
    if (reviewCountedGroups.current.has(groupId)) return;
    reviewCountedGroups.current.add(groupId);
    setReviewStats((current) => {
      const next = { ...current, successfulRuns: Math.max(0, current.successfulRuns || 0) + 1 };
      void chrome.storage.local.set({ [reviewStatsStorageKey]: next });
      return next;
    });
  }

  async function openReviewPage() {
    persistReviewStats({ ...reviewStats, reviewed: true, promptedAt: Date.now() });
    await chrome.tabs.create({ url: chromeWebStoreReviewUrl });
  }

  function postponeReviewPrompt() {
    persistReviewStats({ ...reviewStats, promptedAt: Date.now(), dismissedUntil: Date.now() + reviewPromptCooldownMs });
  }

  async function runQueue() {
    if (!activeTabId) return;
    setMessage("");
    if (validationMessage) {
      addPanelLog("warn", "Run blocked by preflight validation", { validationMessage, mode, promptCount: promptLines.length, imageCount: images.length });
      setMessage(userVisibleMessage(validationMessage, language));
      return;
    }
    addPanelLog("info", "Run button clicked", {
      activeTabId,
      mode,
      prompts: promptLines.length,
      images: images.length
    });
    const groupId = `group-${Date.now().toString(36)}`;
    const payloads = promptLines.map((prompt, index) => payloadFromEditor(groupId, prompt, index));
    await startPayloadGroup(groupId, payloads, settings.concurrentPrompts, "Starting prompt group failed");
  }

  async function startPayloadGroup(groupId: string, payloads: PromptPayload[], concurrentPrompts: number, failureLogMessage: string) {
    if (!activeTabId || payloads.length === 0) return;
    for (const image of images) {
      const result = await prepareImage(activeTabId, image);
      if (!result.success) {
        addPanelLog("error", "Preparing image failed", { image: image.name, error: result.error });
        setMessage(userVisibleMessage(result.error, language));
        return;
      }
    }

    const response = await sendTabMessage<{ results?: PromptGroup["results"]; cancelled?: boolean }>(activeTabId, {
      type: "START_PROMPT_GROUP",
      groupId,
      payloads,
      concurrentPrompts,
      promptDelaySecondsMin: settings.promptDelaySecondsMin,
      promptDelaySecondsMax: settings.promptDelaySecondsMax
    });

    if (!response.success) {
      const error = response.error || firstPromptResultError(response.results) || "Prompt group failed.";
      addPanelLog("error", failureLogMessage, { error });
      setMessage(userVisibleMessage(error, language));
    }
  }

  function payloadFromEditor(groupId: string, prompt: string, index: number): PromptPayload {
    return {
      id: `${groupId}-${index}`,
      prompt,
      mode,
      imageIds: getImageIdsForPrompt(mode, images, settings, defaultImageIds, defaultNoImage, promptImageSelections[index]),
      aspectRatio: aspectRatioForMode(mode, settings.aspectRatio),
      model: settings.model,
      imageModel: settings.imageModel,
      outputCount: settings.outputCount,
      videoDuration: settings.videoDuration,
      autoDownloadResourceQuality: settings.download.autoDownload ? "direct" : "no-download",
      autoChangeFileName: settings.download.autoChangeFileName,
      folderName: settings.download.folderName,
      filePrefix: settings.download.filePrefix,
      maxRetries: settings.maxRetries,
      originalIndex: index
    };
  }

  async function retryFailedResults(results: PromptResult[], promptOverrides: Record<string, string> = {}) {
    if (!activeTabId) return;
    if (!isFlowPage) {
      setMessage(t("openFlowTab"));
      return;
    }
    if (isRunning) {
      setMessage(t("promptGroupRunning"));
      return;
    }
    const failedResults = results.filter((result) => result.status === "error");
    if (failedResults.length === 0) return;
    const groupId = `retry-${Date.now().toString(36)}`;
    const editedResults = failedResults.map((result) => resultWithPromptOverride(result, promptOverrides[result.id]));
    const payloads = editedResults.map((result, retryIndex) => payloadFromFailedResult(groupId, result, retryIndex));
    addPanelLog("info", "Retry failed prompts clicked", {
      activeTabId,
      prompts: payloads.length,
      originalIndexes: payloads.map((payload) => payload.originalIndex)
    });
    setMessage("");
    await startPayloadGroup(groupId, payloads, Math.min(settings.concurrentPrompts, Math.max(1, payloads.length)), "Starting retry group failed");
    setFailedPromptEdits((current) => omitKeys(current, failedResults.map((result) => result.id)));
  }

  function startEditingFailedPrompt(result: PromptResult) {
    setFailedPromptEdits((current) => ({ ...current, [result.id]: current[result.id] ?? result.prompt }));
  }

  function updateFailedPromptEdit(resultId: string, value: string) {
    setFailedPromptEdits((current) => ({ ...current, [resultId]: value }));
  }

  function cancelFailedPromptEdit(resultId: string) {
    setFailedPromptEdits((current) => omitKeys(current, [resultId]));
  }

  function retryEditedFailedPrompt(result: PromptResult) {
    void retryFailedResults([result], { [result.id]: failedPromptEdits[result.id] ?? result.prompt });
  }

  function payloadFromFailedResult(groupId: string, result: PromptResult, retryIndex: number): PromptPayload {
    const originalIndex = Math.max(0, result.index);
    const source = result.payload;
    if (source) {
      return {
        ...source,
        id: `${groupId}-${originalIndex}-${retryIndex}`,
        prompt: result.prompt || source.prompt,
        autoDownloadResourceQuality: settings.download.autoDownload ? "direct" : "no-download",
        autoChangeFileName: settings.download.autoChangeFileName,
        folderName: settings.download.folderName,
        filePrefix: settings.download.filePrefix,
        maxRetries: settings.maxRetries,
        originalIndex
      };
    }
    return {
      ...payloadFromEditor(groupId, result.prompt, originalIndex),
      id: `${groupId}-${originalIndex}-${retryIndex}`,
      originalIndex
    };
  }

  async function cancelGroup(groupId: string) {
    if (!activeTabId) return;
    await sendTabMessage(activeTabId, { type: "CANCEL_PROMPT_GROUP", groupId });
  }

  async function clearSession() {
    const response = await sendRuntimeMessage({ type: "CLEAR_FLOW_SESSION" });
    addPanelLog(response.success ? "info" : "error", response.success ? "Clear cache requested" : "Clear cache failed", response);
    setMessage(response.success ? t("cacheCleared") : userVisibleMessage(response.error, language));
  }

  async function clearLogs() {
    await sendRuntimeMessage({ type: "CLEAR_LOGS" });
    setLogs([]);
  }

  async function copyLogs() {
    const text = formatLogs(logs);
    await navigator.clipboard.writeText(text);
    setMessage(t("logsCopied"));
  }

  function downloadLogs() {
    const blob = new Blob([formatLogs(logs)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `flow-queue-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function onPromptFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    const text = await file.text();
    setPrompts((current) => joinPrompts([...splitPrompts(current), ...parsePromptFile(text)]));
  }

  async function onImages(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    if (files.length === 0) return;
    input.value = "";
    const prepared = await Promise.all(files.map(readImageFile));
    setImages((current) => [...current, ...prepared]);
    setDefaultImageIds((current) => current.length ? current : prepared[0] ? [prepared[0].id] : []);
  }

  async function replacePromptImage(index: number, event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    const prepared = await readImageFile(file);
    setImages((current) => [...current, prepared]);
    setPromptImageSelections((current) => ({ ...current, [index]: [prepared.id] }));
  }

  return (
    <main className={`shell ${darkMode ? "darkMode" : ""}`} lang={language} dir={languageDirection(language)}>
      <header className="topbar">
        <div className="brand">
          <div className="mark">
            <FlowQueueMark />
          </div>
          <div>
            <h1>{t("appTitle")}</h1>
            <p>
              <span className={`statusDot ${isFlowPage ? "ready" : ""}`} />
              {isFlowPage ? t("connectedReady") : t("waitingForFlow")}
            </p>
          </div>
        </div>
        <div className="topActions">
          <LanguageField compact label={t("language")} value={language} onChange={setLanguage} />
          <button
            className={`iconButton ${darkMode ? "active" : ""}`}
            onClick={() => setDarkMode((current) => !current)}
            title={darkMode ? t("switchToLightMode") : t("switchToDarkMode")}
            aria-pressed={darkMode}
          >
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <section className={`connection ${isFlowPage ? "ready" : "blocked"}`}>
        <div>
          <strong>{isFlowPage ? t("readyToUse") : t("googleFlowNotConnected")}</strong>
          <span>{isFlowPage ? t("thisTabWorkspace") : t("openProjectTab")}</span>
        </div>
        <button onClick={openGoogleFlow}>
          <ExternalLink size={16} />
          {t("openGoogleFlow")}
        </button>
      </section>

      {visibleMessage && (
        <section className="notice" role="status" aria-live="polite">
          <strong>{t("actionNeeded")}</strong>
          <span>{visibleMessage}</span>
        </section>
      )}

      {shouldShowReviewPrompt && (
        <div className="reviewOverlay" role="presentation">
          <section className="reviewPrompt" role="alertdialog" aria-live="polite" aria-modal="true" aria-labelledby="reviewPromptTitle">
            <span className="reviewIcon">
              <Star size={22} />
            </span>
            <div className="reviewCopy">
              <strong id="reviewPromptTitle">{t("reviewPromptTitle")}</strong>
              <span>{t("reviewPromptText")}</span>
            </div>
            <div className="reviewActions">
              <button className="primary" onClick={openReviewPage}>{t("reviewPromptAction")}</button>
              <button onClick={postponeReviewPrompt}>{t("reviewPromptLater")}</button>
            </div>
          </section>
        </div>
      )}

      <section className="panel">
        <div className="sectionTitle">
          <ListChecks size={18} />
          <h2>{t("queue")}</h2>
          <span>{promptLines.length}</span>
        </div>

        <div className="segmented">
          {modes.map((item) => (
            <button key={item.value} className={mode === item.value ? "active" : ""} onClick={() => setMode(item.value)}>
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <label className="field">
          <span>{t("prompts")}</span>
          <textarea
            value={prompts}
            onChange={(event) => setPrompts(event.target.value)}
            placeholder={t("promptsPlaceholder")}
          />
        </label>

        <div className="toolbar">
          <label className="fileButton">
            <FilePlus2 size={16} />
            {t("importPrompts")}
            <input type="file" accept=".txt,.csv,.tsv,.json" onChange={onPromptFile} />
          </label>
          <label className="fileButton">
            <ImagePlus size={16} />
            {t("addImages")}
            <input type="file" accept="image/*" multiple onChange={onImages} />
          </label>
          <button onClick={() => setPrompts("")}>
            <Trash2 size={16} />
            {t("clear")}
          </button>
        </div>

        {images.length > 0 && (
          <div className="imageGrid">
            {images.map((image) => (
              <figure key={image.id}>
                <img src={image.dataUrl} alt={image.name} />
                <button title={t("removeImage")} onClick={() => removeImage(image.id)}>
                  <Ban size={14} />
                </button>
              </figure>
            ))}
          </div>
        )}

        {promptLines.length > 0 && (
          <div className="promptReview">
            <div className="subhead">
              <strong>{t("promptReview")}</strong>
              <span>{promptLines.length}</span>
            </div>
            {modeNeedsImages && images.length > 0 && (
              <div className="defaultImageRow">
                <MultiImagePicker
                  label={defaultNoImage && mode === "image-to-image" ? t("defaultImagesNone") : t("defaultImages")}
                  images={images}
                  selectedIds={defaultNoImage && mode === "image-to-image" ? [] : effectiveDefaultImageIds(images, settings, mode, defaultImageIds)}
                  max={maxImagesForMode(mode, settings)}
                  onChange={(value) => {
                    setDefaultNoImage(false);
                    setDefaultImageIds(value);
                  }}
                />
                {mode === "image-to-image" && (
                  <div className="promptImageActions defaultImageActions">
                    <button
                      type="button"
                      className={`imageActionButton ${defaultNoImage ? "active" : ""}`}
                      onClick={() => setDefaultNoImage((current) => !current)}
                    >
                      <Ban size={15} />
                      {t("noImage")}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="promptRows">
              {promptLines.map((prompt, index) => {
                const promptSelection = promptImageSelections[index];
                const isNoImageSelected = promptSelection === null;
                const selectedImageIds = getImageIdsForPrompt(mode, images, settings, defaultImageIds, defaultNoImage, promptSelection) ?? [];
                const isUsingDefaultImages = promptSelection === undefined || (Array.isArray(promptSelection) && promptSelection.length === 0);
                return (
                  <article className="promptRow" key={index}>
                    <label className="field compact promptEdit">
                      <span>{t("prompt", { number: index + 1 })}</span>
                      <textarea value={prompt} onChange={(event) => updatePromptLine(index, event.target.value)} />
                    </label>
                    {modeNeedsImages && (
                      <div className="promptImageTools multi">
                        <MultiImagePicker
                          label={isNoImageSelected ? t("imagesNone") : isUsingDefaultImages ? t("imagesDefault") : t("images")}
                          images={images}
                          selectedIds={selectedImageIds}
                          max={maxImagesForMode(mode, settings)}
                          onChange={(value) => setPromptImageSelections((current) => ({ ...current, [index]: value }))}
                        />
                        <div className="promptImageActions">
                          {mode === "image-to-image" && (
                            <button
                              type="button"
                              className={`imageActionButton ${isNoImageSelected ? "active" : ""}`}
                              onClick={() => setPromptImageSelections((current) => ({ ...current, [index]: isNoImageSelected ? [] : null }))}
                            >
                              <Ban size={15} />
                              {t("noImage")}
                            </button>
                          )}
                          {!isUsingDefaultImages && (
                            <button
                              type="button"
                              className="ghost resetImagesButton"
                              onClick={() => setPromptImageSelections((current) => omitPromptSelection(current, index))}
                            >
                              {t("useDefault")}
                            </button>
                          )}
                          <label className="fileButton replaceButton">
                            <ImagePlus size={16} />
                            {t("replace")}
                            <input type="file" accept="image/*" onChange={(event) => replacePromptImage(index, event)} />
                          </label>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}

        <div className="runbar">
          <button className="primary" disabled={!canRun} onClick={runQueue}>
            <Play size={18} />
            {t("run")}
          </button>
          <button onClick={clearSession}>
            <RefreshCcw size={16} />
            {t("clearCache")}
          </button>
        </div>
        {visibleMessage && <p className="message">{visibleMessage}</p>}
        {modeNeedsImages && images.length === 0 && (
          <p className="hint">{t("modeNeedsImage", { mode: modeLabelForUi(mode, language) })}</p>
        )}
      </section>

      <section className="panel">
        <div className="sectionTitle">
          <Settings size={18} />
          <h2>{t("settings")}</h2>
          <button className="ghost" onClick={() => setSettings(DEFAULT_SETTINGS)}>
            {t("reset")}
          </button>
        </div>

        <div className="grid2">
          <NumberField label={t("concurrent")} value={settings.concurrentPrompts} min={1} max={5} onChange={(value) => updateSetting("concurrentPrompts", value)} />
          <NumberField label={t("retries")} value={settings.maxRetries} min={0} max={10} onChange={(value) => updateSetting("maxRetries", value)} />
          <NumberField label={t("delayMin")} value={settings.promptDelaySecondsMin} min={0} max={120} onChange={(value) => updateSetting("promptDelaySecondsMin", value)} />
          <NumberField label={t("delayMax")} value={settings.promptDelaySecondsMax} min={0} max={120} onChange={(value) => updateSetting("promptDelaySecondsMax", value)} />
        </div>

        <div className="flowOptions">
          <ChoiceField
            label={t("outputType")}
            options={[
              { value: "image", label: t("image"), icon: <ImageIcon size={16} /> },
              { value: "video", label: t("video"), icon: <Video size={16} /> }
            ]}
            value={mode.includes("video") ? "video" : "image"}
            onChange={(value) => setMode(value === "video" ? "text-to-video" : "text-to-image")}
          />
          <ChoiceField
            label={t("aspectRatio")}
            options={mode.includes("video") ? videoAspectOptions : aspectOptions}
            value={aspectRatioForMode(mode, settings.aspectRatio)}
            onChange={(value) => updateSetting("aspectRatio", value)}
          />
          <ChoiceField label={t("outputs")} options={outputOptions} value={settings.outputCount} onChange={(value) => updateSetting("outputCount", value)} />
          {mode.includes("video") ? (
            <>
              <ChoiceField label={t("videoModel")} options={videoModelOptions} value={settings.model} onChange={(value) => updateSetting("model", value)} />
              <ChoiceField label={t("videoDuration")} options={durationOptions} value={settings.videoDuration} onChange={(value) => updateSetting("videoDuration", value)} />
            </>
          ) : (
            <ChoiceField label={t("imageModel")} options={imageModelOptions} value={settings.imageModel} onChange={(value) => updateSetting("imageModel", value)} />
          )}
        </div>

        <AutoDownloadToggle label={t("autoDownload")} onLabel={t("on")} offLabel={t("off")} checked={settings.download.autoDownload} onChange={(value) => updateDownload("autoDownload", value)} />

        <div className="grid2">
          <TextField label={t("folder")} value={settings.download.folderName} onChange={(value) => updateDownload("folderName", value)} />
          <TextField label={t("prefix")} value={settings.download.filePrefix} onChange={(value) => updateDownload("filePrefix", value)} />
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.download.autoChangeFileName}
            onChange={(event) => updateDownload("autoChangeFileName", event.target.checked)}
          />
          {t("renameDownloads")}
        </label>
      </section>

      <section className="panel runsPanel">
        <div className="sectionTitle">
          <Download size={18} />
          <h2>{t("runs")}</h2>
        </div>
        {!latestGroup && <p className="empty">{t("noPromptGroups")}</p>}
        {groups.map((group) => {
          const failedResults = group.results.filter((result) => result.status === "error");
          return (
            <article className="group" key={group.id}>
              <div className="groupHead">
                <strong>{group.status}</strong>
                <span>{group.processedCount}/{group.totalCount}</span>
                {failedResults.length > 0 && group.status !== "running" && (
                  <button onClick={() => retryFailedResults(failedResults)} disabled={isRunning}>
                    <RefreshCcw size={14} />
                    {t("retryFailed")}
                  </button>
                )}
                {group.status === "running" && (
                  <button onClick={() => cancelGroup(group.id)}>
                    <Square size={14} />
                    {t("stop")}
                  </button>
                )}
              </div>
              <div className="progressTrack">
                <div style={{ width: `${Math.round((group.processedCount / Math.max(1, group.totalCount)) * 100)}%` }} />
              </div>
              <div className="runResults" aria-label={t("runningResultsLabel", { status: group.status })}>
                {group.results.map((result) => {
                  const editValue = failedPromptEdits[result.id];
                  const isEditingFailedPrompt = editValue !== undefined;
                  return (
                    <div className={`result ${result.status} ${isEditingFailedPrompt ? "editing" : ""}`} key={result.id}>
                      {result.status === "completed" ? <CheckCircle2 size={15} /> : result.status === "error" ? <XCircle size={15} /> : <span className="dot" />}
                      <span title={result.prompt}>{result.index + 1}. {result.prompt}</span>
                      <em>{resultStatusLabel(result, language)}</em>
                      {result.status === "error" && (
                        <div className="resultActions">
                          <button className="resultIconButton" title={t("editPrompt")} onClick={() => startEditingFailedPrompt(result)} disabled={isRunning}>
                            <Pencil size={13} />
                          </button>
                          <button className="resultIconButton" title={t("retryThis")} onClick={() => retryFailedResults([result])} disabled={isRunning}>
                            <RefreshCcw size={13} />
                          </button>
                        </div>
                      )}
                      {isEditingFailedPrompt && (
                        <div className="failedPromptEditor">
                          <textarea
                            value={editValue}
                            onChange={(event) => updateFailedPromptEdit(result.id, event.target.value)}
                            aria-label={t("editFailedPrompt")}
                          />
                          <div className="failedPromptEditorActions">
                            <button className="primary" onClick={() => retryEditedFailedPrompt(result)} disabled={isRunning || editValue.trim().length === 0}>
                              <RefreshCcw size={13} />
                              {t("retryEdited")}
                            </button>
                            <button onClick={() => cancelFailedPromptEdit(result.id)}>
                              {t("cancelEdit")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </section>

      <details className="panel diagnostics">
        <summary className="sectionTitle diagnosticsSummary">
          <Bug size={18} />
          <h2>{t("diagnostics")}</h2>
          <span>{logs.length}</span>
        </summary>
        <div className="toolbar">
          <button onClick={copyLogs} disabled={logs.length === 0}>
            <Clipboard size={16} />
            {t("copy")}
          </button>
          <button onClick={downloadLogs} disabled={logs.length === 0}>
            <Download size={16} />
            {t("export")}
          </button>
          <button onClick={clearLogs} disabled={logs.length === 0}>
            <XCircle size={16} />
            {t("clearLogs")}
          </button>
        </div>
        <div className="logList">
          {logs.length === 0 && <p className="empty">{t("noLogs")}</p>}
          {logs.slice(-80).reverse().map((entry) => (
            <details className={`log ${entry.level}`} key={entry.id}>
              <summary>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <strong>{entry.level}</strong>
                <span>{entry.message}</span>
              </summary>
              <pre>{JSON.stringify({ source: entry.source, groupId: entry.groupId, promptIndex: entry.promptIndex, details: entry.details }, null, 2)}</pre>
            </details>
          ))}
        </div>
      </details>
    </main>
  );

  function updateSetting<K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function updateDownload<K extends keyof AutomationSettings["download"]>(key: K, value: AutomationSettings["download"][K]) {
    setSettings((current) => ({ ...current, download: { ...current.download, [key]: value } }));
  }

  function addPanelLog(level: FlowLogEntry["level"], text: string, details?: unknown) {
    const entry: FlowLogEntry = {
      id: `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      level,
      source: "sidepanel",
      message: text,
      details
    };
    void sendRuntimeMessage({ type: "LOG_EVENT", entry });
  }

  function updatePromptLine(index: number, value: string) {
    setPrompts((current) => {
      const lines = splitPrompts(current);
      lines[index] = value;
      return joinPrompts(lines);
    });
  }

  function removeImage(imageId: string) {
    setImages((current) => {
      const nextImages = current.filter((image) => image.id !== imageId);
      setDefaultImageIds((currentDefault) => {
        const nextDefault = currentDefault.filter((id) => id !== imageId);
        return nextDefault.length ? nextDefault : nextImages[0] ? [nextImages[0].id] : [];
      });
      return nextImages;
    });
    setPromptImageSelections((current) => Object.fromEntries(
      Object.entries(current)
        .map(([index, selectedIds]) => {
          if (selectedIds === null) return [index, null] as const;
          return [index, selectedIds.filter((id) => id !== imageId)] as const;
        })
        .filter(([, selectedIds]) => selectedIds === null || selectedIds.length > 0)
    ));
  }
}

function FlowQueueMark() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="28" fill="#f6f8fb" />
      <path d="M22 22h57v20H44v16h29v19H44v29H22V22Z" fill="#f43b9d" />
      <path d="m22 22 12 8v76l-12 8V22Z" fill="#cf247d" />
      <path d="M77 39c19 0 32 14 32 34 0 9-3 17-8 23l11 11-14 13-12-13c-3 1-6 1-9 1-19 0-32-14-32-35s13-34 32-34Zm0 20c-7 0-11 5-11 14 0 10 4 15 11 15s11-5 11-15c0-9-4-14-11-14Z" fill="#28c7e7" fillRule="evenodd" />
      <path d="m86 88 15 8 11 11-14 13-12-13V88Z" fill="#16a8d0" />
      <path d="M44 58h29v19H44V58Z" fill="#ff6c73" />
    </svg>
  );
}

function firstPromptGroupError(group: PromptGroup) {
  return firstPromptResultError(group.results);
}

function isSuccessfulPromptGroup(group: PromptGroup) {
  return group.status === "completed" &&
    group.totalCount > 0 &&
    group.results.length === group.totalCount &&
    group.results.every((result) => result.status === "completed");
}

function normalizeReviewStats(value: unknown): ReviewStats {
  if (!value || typeof value !== "object") return { successfulRuns: 0 };
  const stats = value as Partial<ReviewStats>;
  return {
    successfulRuns: typeof stats.successfulRuns === "number" && Number.isFinite(stats.successfulRuns) ? Math.max(0, stats.successfulRuns) : 0,
    promptedAt: typeof stats.promptedAt === "number" ? stats.promptedAt : undefined,
    dismissedUntil: typeof stats.dismissedUntil === "number" ? stats.dismissedUntil : undefined,
    reviewed: stats.reviewed === true
  };
}

function firstPromptResultError(results: PromptGroup["results"] | undefined) {
  return results?.find((result) => result.status === "error" && result.error)?.error;
}

function userFacingLogMessage(entry: FlowLogEntry, language: LanguageCode) {
  if (entry.level !== "error") return "";
  const details = entry.details && typeof entry.details === "object" ? entry.details as Record<string, unknown> : {};
  const error = details.error;
  if (typeof error === "string" && error.trim()) return userVisibleMessage(error, language);
  return userVisibleMessage(entry.message, language);
}

function userVisibleMessage(value: unknown, language: LanguageCode) {
  const message = typeof value === "string" ? value : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("flow cache cleared")) return translate(language, "cacheCleared");
  if (
    normalized.includes("generation tile did not appear") ||
    normalized.includes("flow output did not finish") ||
    normalized.includes("flow generation failed") ||
    normalized.includes("flow create button is disabled")
  ) {
    return "Flow could not start or finish this generation. Please check Google Flow, then try again.";
  }
  if (
    normalized.includes("please open new project") ||
    normalized.includes("new project in google flow") ||
    normalized.includes("new project workspace")
  ) {
    return translate(language, "newProjectMessage");
  }
  return "";
}

function resultStatusLabel(result: PromptGroup["results"][number], language: LanguageCode) {
  if (result.status === "completed") return translate(language, "doneStatus");
  if (result.status === "error") return translate(language, "errorStatus");
  if (result.status === "cancelled") return translate(language, "cancelStatus");
  return `${result.percentage}%`;
}

function getValidationMessage(isFlowPage: boolean, promptCount: number, mode: PromptMode, imageCount: number, isRunning: boolean, language: LanguageCode) {
  if (!isFlowPage) return translate(language, "openFlowTab");
  if (isRunning) return translate(language, "promptGroupRunning");
  if (promptCount === 0) return translate(language, "addAtLeastOnePrompt");
  if (mediaRequiredModes.includes(mode) && imageCount === 0) {
    return translate(language, "modeNeedsImage", { mode: modeLabelForUi(mode, language) });
  }
  return "";
}

function aspectRatioForMode(mode: PromptMode, aspectRatio: string) {
  if (!mode.includes("video")) return aspectRatio;
  return aspectRatio === "16:9" || aspectRatio === "4:3" ? "16:9" : "9:16";
}

function getImageIdsForPrompt(
  mode: PromptMode,
  images: PreparedImage[],
  settings: AutomationSettings,
  defaultImageIds: string[],
  defaultNoImage: boolean,
  selectedImageIds?: PromptImageSelection
) {
  if (!mediaRequiredModes.includes(mode)) return undefined;
  if (selectedImageIds === null) return [];
  if (defaultNoImage && mode === "image-to-image" && !selectedImageIds?.length) return [];
  const imageIds = selectedImageIds?.length ? selectedImageIds : effectiveDefaultImageIds(images, settings, mode, defaultImageIds);
  const available = new Set(images.map((image) => image.id));
  return imageIds.filter((id) => available.has(id)).slice(0, maxImagesForMode(mode, settings));
}

function effectiveDefaultImageIds(images: PreparedImage[], settings: AutomationSettings, mode: PromptMode, defaultImageIds: string[]) {
  const available = new Set(images.map((image) => image.id));
  const selected = defaultImageIds.filter((id) => available.has(id));
  return (selected.length ? selected : images[0] ? [images[0].id] : []).slice(0, maxImagesForMode(mode, settings));
}

function maxImagesForMode(mode: PromptMode, settings: AutomationSettings) {
  return mode === "image-to-image" ? settings.imageToImageMaxImages : settings.imageToVideoMaxImages;
}

function omitPromptSelection(current: Record<number, PromptImageSelection>, index: number) {
  const next = { ...current };
  delete next[index];
  return next;
}

function omitKeys<T>(current: Record<string, T>, keys: string[]) {
  const next = { ...current };
  for (const key of keys) delete next[key];
  return next;
}

function resultWithPromptOverride(result: PromptResult, promptOverride?: string): PromptResult {
  if (promptOverride === undefined) return result;
  return {
    ...result,
    prompt: promptOverride,
    payload: result.payload ? { ...result.payload, prompt: promptOverride } : result.payload
  };
}

function modeLabelForUi(mode: PromptMode, language: LanguageCode) {
  const labelKey = modes.find((item) => item.value === mode)?.labelKey;
  return labelKey ? translate(language, labelKey) : mode;
}

function isLikelyFlowUrl(url?: string) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "flow.google.com" || (parsed.hostname === "labs.google" && parsed.href.includes("flow"));
  } catch {
    return false;
  }
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commitValue(rawValue = draft) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const nextValue = Math.min(max, Math.max(min, parsed));
    setDraft(String(nextValue));
    onChange(nextValue);
  }

  return (
    <label className="field compact">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commitValue()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field compact">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LanguageField({
  label,
  value,
  onChange,
  compact = false
}: {
  label: string;
  value: LanguageCode;
  onChange: (value: LanguageCode) => void;
  compact?: boolean;
}) {
  const selectedLanguage = supportedLanguages.find((language) => language.code === value);
  return (
    <label className={compact ? "languageSelect compactTop" : "field compact"}>
      {compact ? <span>{selectedLanguage?.nativeLabel ?? value.toUpperCase()}</span> : <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(normalizeLanguageCode(event.target.value))}>
        {supportedLanguages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.nativeLabel} - {language.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChoiceField<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="choiceField">
      <span>{label}</span>
      <div className="choiceGrid" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={Object.is(value, option.value) ? "active" : ""}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AutoDownloadToggle({
  label,
  onLabel,
  offLabel,
  checked,
  onChange
}: {
  label: string;
  onLabel: string;
  offLabel: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`autoDownloadToggle ${checked ? "active" : ""}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="autoDownloadLabel">
        <span className="autoDownloadIcon">
          <Download size={18} />
        </span>
        <span>
          <strong>{label}</strong>
          <em>{checked ? onLabel : offLabel}</em>
        </span>
      </span>
      <span className="autoDownloadSwitch">
        <span />
      </span>
    </button>
  );
}

function MultiImagePicker({
  label,
  images,
  selectedIds,
  max,
  onChange
}: {
  label: string;
  images: PreparedImage[];
  selectedIds: string[];
  max: number;
  onChange: (value: string[]) => void;
}) {
  const selected = selectedIds.filter((id) => images.some((image) => image.id === id)).slice(0, max);

  function toggleImage(imageId: string) {
    if (selected.includes(imageId)) {
      onChange(selected.filter((id) => id !== imageId));
      return;
    }
    onChange([...selected, imageId].slice(0, max));
  }

  return (
    <div className="multiImagePicker">
      <div className="multiImageHead">
        <span>{label}</span>
        <em>{selected.length}/{max}</em>
      </div>
      <div className="multiImageChoices">
        {images.map((image) => {
          const checked = selected.includes(image.id);
          const disabled = !checked && selected.length >= max;
          return (
            <label className={`imageChoice ${checked ? "active" : ""} ${disabled ? "disabled" : ""}`} key={image.id} title={image.name}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleImage(image.id)} />
              <img src={image.dataUrl} alt="" />
              <span>{image.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function splitPrompts(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function joinPrompts(values: string[]) {
  return values.join("\n");
}

function parsePromptFile(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : Object.values(parsed);
      return rows.flatMap((row) => typeof row === "string" ? [row] : row && typeof row === "object" ? [String((row as { prompt?: unknown }).prompt ?? "")] : []);
    } catch {
      return splitPrompts(trimmed);
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.split(/\t|,/).find(Boolean)?.trim() || "")
    .filter(Boolean);
}

function readImageFile(file: File): Promise<PreparedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve({
      id: `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mimeType: file.type,
      dataUrl: String(reader.result)
    });
    reader.readAsDataURL(file);
  });
}

async function prepareImage(tabId: number, image: PreparedImage) {
  const serialized = JSON.stringify(image);
  const maxSize = 256 * 1024;
  if (serialized.length < maxSize) {
    return sendTabMessage(tabId, { type: "PREPARE_IMAGE", id: image.id, image });
  }
  const chunks = serialized.match(new RegExp(`.{1,${maxSize}}`, "g")) ?? [];
  for (let index = 0; index < chunks.length; index += 1) {
    const response = await sendTabMessage(tabId, {
      type: "PREPARE_IMAGE_CHUNK",
      id: image.id,
      chunk: chunks[index],
      chunkIndex: index,
      totalChunks: chunks.length
    });
    if (!response.success) return response;
  }
  return { success: true as const };
}

function formatLogs(logs: FlowLogEntry[]) {
  return logs
    .map((entry) => {
      const header = `[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}`;
      const details = entry.details === undefined ? "" : `\n${JSON.stringify(entry.details, null, 2)}`;
      return `${header}${details}`;
    })
    .join("\n\n");
}

createRoot(document.getElementById("root")!).render(<App />);

import { flowSelectors } from "../shared/selectors";
import { sendRuntimeMessage } from "../shared/messaging";
import type {
  FlowSelectors,
  FlowLogEntry,
  PreparedImage,
  PromptGroup,
  PromptPayload,
  PromptResult,
  RuntimeRequest,
  RuntimeResponse,
  StartPromptGroupRequest,
  VideoResourceCandidate
} from "../shared/types";

const preparedImages = new Map<string, PreparedImage>();
const chunkBuffer = new Map<string, { chunks: string[]; totalChunks: number }>();
const promptGroups = new Map<string, RunningGroup>();
const generatedCardIds = new WeakMap<Element, string>();
const generatedCardOwners = new WeakMap<Element, number>();
const staleResourceUrlsByPromptRun = new Map<string, Set<string>>();
const trustedVideoResourceUrls = new Map<string, number>();
let activeGroupId: string | undefined;
let lastConfigSignature = "";
let lastComposerAttachmentSignature = "";
const videoFailureGraceMs = 2 * 60 * 1000;
const imageFailureGraceMs = 45 * 1000;
const imageTileStuckProbeMs = 45 * 1000;
const videoCompletedWithoutUrlGraceMs = 5 * 60 * 1000;
const highConcurrencyImageDownloadDelayMs = 2500;
const highConcurrencyVideoDownloadDelayMs = 5000;
const maxHighConcurrencyDownloadDelayMs = 10000;
const initialAttachmentReadyWaitMs = 15000;
const pendingAttachmentReadyWaitMs = 35000;
const stagedImageInitialLibraryWaitMs = 10000;
const stagedImageLibraryWaitMs = 45000;
const composerReadyWaitMs = 30000;
const composerControlReadyWaitMs = 12000;
const generationRevealIntervalMs = 2500;
const openNewProjectMessage = "Please open New project in Google Flow, then run again";
const flowCardDownloadResourcePrefix = "flow-card-download:";

interface RunningGroup extends PromptGroup {
  payloads: PromptPayload[];
  concurrentPrompts: number;
  promptDelaySecondsMin: number;
  promptDelaySecondsMax: number;
  pendingIndexes: number[];
  runningIndexes: Set<number>;
  completedIndexes: Set<number>;
  submittedIndexes: Set<number>;
  submittedAtByIndex: Map<number, number>;
  knownBeforeTileIdsByIndex: Map<number, Set<string>>;
  tileFirstSeenAt: Map<string, number>;
  tileOwners: Map<string, number>;
  tileOwnerClaims: Map<string, TileOwnerClaim>;
  tileOwnerRects: Map<string, RectSnapshot>;
  downloadedResourceKeys: Set<string>;
  videoResourceClaims: Map<string, number>;
  tileWaitOrder: number[];
  tileCandidateMemory: Map<number, TileCandidateMemory[]>;
  retryCounts: Record<number, number>;
  submissionQueue: Promise<void>;
  submittedPromptCount: number;
  respond: (value: unknown) => void;
}

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TileCandidateMemory {
  tileId: string;
  rect: RectSnapshot | null;
}

type TileOwnerReason = "generic" | "exclusive-new-card" | "timed-generated-card" | "prompt-match";

interface TileOwnerClaim {
  index: number;
  reason: TileOwnerReason;
}

interface PromptSubmission {
  knownBeforeSubmit: string[];
}

interface AttachmentState {
  requiredCount: number;
  allowReadyFallback: boolean;
}

chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true;
});

sendRuntimeMessage({ type: "SET_ZOOM", zoomFactor: isFlowPage() ? 0.8 : 1 }).catch(() => undefined);

async function handleMessage(message: RuntimeRequest, sendResponse: (response?: unknown) => void) {
  try {
    switch (message.type) {
      case "CHECK_FLOW_PAGE":
        sendResponse({ success: true, isFlowPage: isFlowPage() });
        break;
      case "GET_FLOW_SELECTORS":
        sendResponse({ success: true, selectors: flowSelectors });
        break;
      case "PREPARE_IMAGE":
        preparedImages.set(message.id, message.image);
        sendResponse({ success: true });
        break;
      case "PREPARE_IMAGE_CHUNK":
        sendResponse(prepareImageChunk(message.id, message.chunk, message.chunkIndex, message.totalChunks));
        break;
      case "START_PROMPT_GROUP":
        await startPromptGroup(message, sendResponse);
        break;
      case "CANCEL_PROMPT_GROUP":
        sendResponse(cancelPromptGroup(message.groupId));
        break;
      case "SCAN_CHARACTERS":
        sendResponse({ success: true, characters: await scanCharacters(flowSelectors) });
        break;
      default:
        sendResponse({ success: true });
    }
  } catch (error) {
    log("error", "Message handler failed", { messageType: message.type, error: errorToText(error) });
    sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function prepareImageChunk(id: string, chunk: string, chunkIndex: number, totalChunks: number) {
  const entry = chunkBuffer.get(id) ?? { chunks: Array(totalChunks).fill(""), totalChunks };
  entry.chunks[chunkIndex] = chunk;
  chunkBuffer.set(id, entry);
  const received = entry.chunks.filter(Boolean).length;
  if (received !== entry.totalChunks) {
    return { success: true, chunkReceived: true, receivedCount: received, totalChunks: entry.totalChunks };
  }

  const image = JSON.parse(entry.chunks.join("")) as PreparedImage;
  preparedImages.set(id, image);
  chunkBuffer.delete(id);
  return { success: true };
}

async function startPromptGroup(request: StartPromptGroupRequest, sendResponse: (response?: unknown) => void) {
  if (!isFlowPage()) {
    log("error", "Start blocked because this tab is not a Flow page", { href: location.href });
    sendResponse({ success: false, error: "Open a Google Flow page before starting automation." });
    return;
  }

  if (activeGroupId) {
    sendResponse({ success: false, error: "Another prompt group is already running in this tab." });
    return;
  }

  await closeUntitledSessionPanel();
  const workspaceError = flowWorkspaceError();
  if (workspaceError) {
    log("warn", "Start blocked because Flow project workspace is not open", { href: location.href, error: workspaceError });
    sendResponse({ success: false, error: workspaceError });
    return;
  }

  const group: RunningGroup = {
    id: request.groupId,
    status: "queued",
    createdAt: Date.now(),
    payloads: request.payloads,
    totalCount: request.payloads.length,
    processedCount: 0,
    results: request.payloads.map((payload, index) => resultFor(payload, index, "pending")),
    concurrentPrompts: Math.max(1, request.concurrentPrompts || 1),
    promptDelaySecondsMin: Math.max(0, request.promptDelaySecondsMin || 0),
    promptDelaySecondsMax: Math.max(0, request.promptDelaySecondsMax || 0),
    pendingIndexes: request.payloads.map((_, index) => index),
    runningIndexes: new Set(),
    completedIndexes: new Set(),
    submittedIndexes: new Set(),
    submittedAtByIndex: new Map(),
    knownBeforeTileIdsByIndex: new Map(),
    tileFirstSeenAt: new Map(),
    tileOwners: new Map(),
    tileOwnerClaims: new Map(),
    tileOwnerRects: new Map(),
    downloadedResourceKeys: new Set(),
    videoResourceClaims: new Map(),
    tileWaitOrder: [],
    tileCandidateMemory: new Map(),
    retryCounts: {},
    submissionQueue: Promise.resolve(),
    submittedPromptCount: 0,
    respond: () => undefined
  };
  rememberObservedTileIds(group, collectTileIds(), group.createdAt);

  promptGroups.set(group.id, group);
  log("info", "Prompt group queued", {
    groupId: group.id,
    totalCount: group.totalCount,
    concurrentPrompts: group.concurrentPrompts,
    mode: request.payloads[0]?.mode
  });
  publish(group);
  sendResponse({ success: true, groupId: group.id });

  runGroup(group).catch((error) => {
    log("error", "Prompt group crashed", { groupId: group.id, error: errorToText(error) }, group.id, group.currentIndex);
    group.status = "error";
    updateResult(group, group.currentIndex ?? 0, { status: "error", error: error instanceof Error ? error.message : String(error) });
    publish(group);
    group.respond({ success: false, error: error instanceof Error ? error.message : String(error), results: group.results });
  });
}

function cancelPromptGroup(groupId: string) {
  const group = promptGroups.get(groupId);
  if (!group) return { success: false, error: "Prompt group not found" };
  group.isCancelling = true;
  group.status = group.status === "queued" ? "cancelled" : group.status;
  publish(group);
  return { success: true, cancelled: true };
}

async function runGroup(group: RunningGroup) {
  if (activeGroupId && activeGroupId !== group.id) {
    throw new Error("Another prompt group is already running in this tab.");
  }

  activeGroupId = group.id;
  group.status = "running";
  log("info", "Prompt group started", { groupId: group.id }, group.id);
  await sendRuntimeMessage({ type: "ATTACH_DEBUGGER" });
  await sendRuntimeMessage({ type: "SET_ZOOM", zoomFactor: 0.5 });
  publish(group);

  try {
    await preloadRequiredImages(group);
    while (!group.isCancelling && group.completedIndexes.size < group.totalCount) {
      while (
        !group.isCancelling &&
        group.runningIndexes.size < workerLaunchLimit(group) &&
        group.pendingIndexes.length > 0
      ) {
        const index = group.pendingIndexes.shift();
        if (index === undefined) break;
        group.runningIndexes.add(index);
        group.currentIndex = index;
        runPromptWithRetry(group, index).finally(() => group.runningIndexes.delete(index));
      }
      await sleep(300);
    }

    while (group.runningIndexes.size > 0) await sleep(300);

    group.status = group.isCancelling ? "cancelled" : group.results.every((item) => item.status === "completed") ? "completed" : "error";
    group.processedCount = group.completedIndexes.size;
    log(group.status === "completed" ? "info" : "warn", `Prompt group ${group.status}`, {
      groupId: group.id,
      processedCount: group.processedCount,
      totalCount: group.totalCount
    }, group.id);
    publish(group);
    if (group.status === "completed") {
      group.respond({ success: true, results: group.results });
    } else {
      group.respond({
        success: false,
        cancelled: group.status === "cancelled",
        error: firstGroupError(group) ?? (group.status === "cancelled" ? "Prompt group cancelled." : "Prompt group failed."),
        results: group.results
      });
    }
  } finally {
    await sendRuntimeMessage({ type: "DETACH_DEBUGGER" }).catch(() => undefined);
    await sendRuntimeMessage({ type: "SET_ZOOM", zoomFactor: 1 }).catch(() => undefined);
    activeGroupId = undefined;
  }
}

function workerLaunchLimit(group: RunningGroup) {
  const nextIndex = group.pendingIndexes[0];
  const nextPayload = nextIndex === undefined ? undefined : group.payloads[nextIndex];
  const hasRunningVideo = [...group.runningIndexes]
    .some((index) => group.payloads[index]?.mode.includes("video"));
  if (hasRunningVideo || nextPayload?.mode.includes("video")) return 1;
  return group.concurrentPrompts;
}

function firstGroupError(group: RunningGroup) {
  return group.results.find((result) => result.status === "error" && result.error)?.error;
}

async function preloadRequiredImages(group: RunningGroup) {
  collectRequiredPreparedImages(group);
  const imageToVideoImages = collectRequiredPreparedImages(group, "image-to-video");
  if (imageToVideoImages.length === 0) return;

  await stageImagesBeforeVideoGeneration(group, imageToVideoImages);
}

async function stageImagesBeforeVideoGeneration(group: RunningGroup, images: PreparedImage[]) {
  const firstVideoPayload = group.payloads.find((payload) => payload.mode === "image-to-video" && payload.imageIds?.length);
  log("info", "Pasting all required images before video generation", {
    imageCount: images.length,
    imageNames: images.map((image) => image.name)
  }, group.id);

  await ensureCanvasReady();
  if (firstVideoPayload) {
    await configureMode(firstVideoPayload, { strictOutputCount: false });
    await closeTransientFlowUi(group.id);
  }
  await clearComposerAttachments(group.id);

  for (let index = 0; index < images.length; index += 1) {
    if (group.isCancelling) return;
    const image = images[index];
    const percentage = Math.max(1, Math.min(9, Math.round(((index + 1) / images.length) * 9)));
    updateResult(group, 0, {
      status: "running",
      percentage,
      error: `Pasting image ${index + 1}/${images.length} before video generation.`
    });

    await closeTransientFlowUi(group.id);
    await clearComposerAttachments(group.id);
    const attachmentsBefore = countComposerAttachments();
    const pasted = await pasteImagesIntoComposer([image], attachmentsBefore, group.id);
    if (!pasted) {
      throw new Error(`Flow did not accept ${image.name} before video generation.`);
    }

    await closeTransientFlowUi(group.id);
    await clearComposerAttachments(group.id);
    let visibleInLibrary = await waitForPreparedImageInFlowLibrary(image, stagedImageInitialLibraryWaitMs, group.id);
    await closeTransientFlowUi(group.id);
    await clearComposerAttachments(group.id);
    if (!visibleInLibrary) {
      visibleInLibrary = await waitForPreparedImageInFlowLibrary(image, stagedImageLibraryWaitMs, group.id);
      await closeTransientFlowUi(group.id);
      await clearComposerAttachments(group.id);
    }
    if (!visibleInLibrary) {
      throw new Error(`Flow accepted ${image.name}, but it did not appear in uploaded media before video generation.`);
    }
  }

  await closeTransientFlowUi(group.id);
  await clearComposerAttachments(group.id);
  updateResult(group, 0, { status: "pending", percentage: 0, error: undefined });
  log("info", "All required images are ready; starting video generation", {
    imageCount: images.length,
    imageNames: images.map((image) => image.name)
  }, group.id);
}

function collectRequiredPreparedImages(group: RunningGroup, mode?: PromptPayload["mode"]) {
  const imageIds = unique(group.payloads
    .filter((payload) => !mode || payload.mode === mode)
    .flatMap((payload) => payload.imageIds ?? []));
  return imageIds.map((id) => {
    const image = preparedImages.get(id);
    if (!image) throw new Error(`Prepared image was missing before upload: ${id}`);
    return image;
  });
}

async function runPromptWithRetry(group: RunningGroup, index: number) {
  const payload = group.payloads[index];
  const maxRetries = payload.maxRetries ?? 3;

  while (!group.isCancelling) {
    const retry = group.retryCounts[index] ?? 0;
    try {
      log("info", "Prompt run started", { prompt: payload.prompt, mode: payload.mode }, group.id, index);
      updateResult(group, index, { status: "running", percentage: 0, error: undefined });
      const submission = await withSubmissionSlot(group, index, () => executePrompt(payload, group, index));
      updateResult(group, index, { status: "generating", percentage: 10, error: undefined });
      let tileIds: string[];
      try {
        tileIds = await waitForTileIds(payload, group, index, submission.knownBeforeSubmit);
      } finally {
        releaseTileWaiter(group, index);
      }
      updateResult(group, index, { status: "generating", percentage: 15, tileIds });
      const resources = await waitForResources(tileIds, payload, group, index);
      ensureDownloadableResources(payload, resources);
      updateResult(group, index, { status: "downloading", percentage: 95, error: undefined });
      const downloaded = await downloadResources(resources, payload, group, index);
      updateResult(group, index, { status: "completed", percentage: 100, downloaded, error: undefined });
      log("info", "Prompt completed", { tileIds, resources: resources.length, downloaded }, group.id, index);
      staleResourceUrlsByPromptRun.delete(promptRunKey(group, index, payload));
      group.completedIndexes.add(index);
      group.processedCount = group.completedIndexes.size;
      publish(group);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "Prompt attempt failed", {
        retry,
        maxRetries,
        error: errorToText(error),
        diagnostics: collectDiagnostics()
      }, group.id, index);
      releaseTileWaiter(group, index);
      if (group.isCancelling) break;
      if (retry < maxRetries) {
        staleResourceUrlsByPromptRun.delete(promptRunKey(group, index, payload));
        group.retryCounts[index] = retry + 1;
        updateResult(group, index, {
          status: "pending",
          percentage: 0,
          error: `Retry ${retry + 1}/${maxRetries}: ${message}`
        });
        await resetComposerAfterPromptFailure(payload, group.id, index);
        await sleep(1500);
        continue;
      }
      updateResult(group, index, { status: "error", percentage: 100, error: message });
      staleResourceUrlsByPromptRun.delete(promptRunKey(group, index, payload));
      group.completedIndexes.add(index);
      group.processedCount = group.completedIndexes.size;
      publish(group);
      return;
    }
  }

  updateResult(group, index, { status: "cancelled", error: "Cancelled" });
  staleResourceUrlsByPromptRun.delete(promptRunKey(group, index, payload));
  group.completedIndexes.add(index);
  group.processedCount = group.completedIndexes.size;
  publish(group);
}

async function resetComposerAfterPromptFailure(payload: PromptPayload, groupId?: string, promptIndex?: number) {
  try {
    await closeTransientFlowUi(groupId, promptIndex);
    if (payload.imageIds?.length) await clearComposerAttachments(groupId, promptIndex);
    const clearPrompt = findComposerClearPromptButton();
    if (clearPrompt) {
      log("debug", "Clearing stale Flow prompt before retry", { button: describeElement(clearPrompt) }, groupId, promptIndex);
      await clickElement(clearPrompt);
      await sleep(250);
    }
    await closeTransientFlowUi(groupId, promptIndex);
  } catch (cleanupError) {
    log("warn", "Could not fully reset Flow composer before retry", { error: errorToText(cleanupError) }, groupId, promptIndex);
  }
}

function ensureDownloadableResources(payload: PromptPayload, resources: string[]) {
  if (payload.autoDownloadResourceQuality === "no-download") return;
  const matchingResources = payload.mode.includes("video")
    ? resources.filter((resource) => isFlowCardDownloadResource(resource) || videoResourceUrlLooksDownloadable(resource))
    : resources;
  if (matchingResources.length >= payload.outputCount) return;
  throw new Error(`Flow output is visible, but only ${resources.length}/${payload.outputCount} downloadable file URL${payload.outputCount === 1 ? "" : "s"} appeared.`);
}

async function withSubmissionSlot<T>(group: RunningGroup, index: number, callback: () => Promise<T>) {
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = group.submissionQueue.catch(() => undefined);
  group.submissionQueue = previous.then(() => ticket);

  if (group.submittedPromptCount > 0 || group.runningIndexes.size > 1) {
    log("debug", "Prompt waiting for Flow composer turn", {
      promptIndex: index,
      submittedPromptCount: group.submittedPromptCount,
      activeWorkers: group.runningIndexes.size,
      concurrentPrompts: group.concurrentPrompts
    }, group.id, index);
  }

  await previous;
  try {
    if (shouldDelayBeforeSubmission(group, index)) await waitForPromptDelay(group, index);
    if (group.isCancelling) throw new Error("Cancelled");
    group.submittedPromptCount += 1;
    return await callback();
  } finally {
    release();
  }
}

function shouldDelayBeforeSubmission(group: RunningGroup, index: number) {
  const payload = group.payloads[index];
  if (payload?.mode.includes("video")) return group.submittedPromptCount > 0;
  return group.submittedPromptCount >= group.concurrentPrompts;
}

async function executePrompt(payload: PromptPayload, group: RunningGroup, index: number): Promise<PromptSubmission> {
  log("debug", "Ensuring Flow canvas is ready", { href: location.href, tileIds: collectTileIds() }, group.id, index);
  await ensureCanvasReady();
  await ensureComposerAgentOff(group.id, index);
  let attachmentState: AttachmentState = { requiredCount: 0, allowReadyFallback: false };
  if (payload.mode === "image-to-video" && payload.imageIds?.length) {
    await closeTransientFlowUi(group.id, index);
    await clearComposerAttachments(group.id, index);
    await ensureComposerAgentOff(group.id, index);
    try {
      attachmentState = await uploadPreparedImages(payload, group.id, index);
    } catch (error) {
      await clearComposerAttachments(group.id, index);
      throw error;
    }
    ensureRequiredAttachments(attachmentState);
  }
  log("debug", "Configuring Flow mode/options", {
    mode: payload.mode,
    aspectRatio: payload.aspectRatio,
    model: payload.model,
    imageModel: payload.imageModel,
    outputCount: payload.outputCount
  }, group.id, index);
  await configureMode(payload, { strictOutputCount: payload.mode !== "image-to-image" });
  await closeTransientFlowUi(group.id, index);
  ensureRequiredAttachments(attachmentState);
  if (payload.mode !== "image-to-video" && payload.imageIds?.length) {
    attachmentState = await uploadPreparedImages(payload, group.id, index);
  }
  log("debug", "Filling prompt", { length: payload.prompt.length }, group.id, index);
  await fillPrompt(payload.prompt);
  ensureRequiredAttachments(attachmentState);
  await closeTransientFlowUi(group.id, index);
  ensureRequiredAttachments(attachmentState);
  const knownBeforeSubmit = collectTileIds();
  group.knownBeforeTileIdsByIndex.set(index, new Set(knownBeforeSubmit));
  rememberObservedTileIds(group, knownBeforeSubmit);
  const staleResourceUrls = collectVisibleResourceUrls(payload.mode.includes("video"));
  staleResourceUrlsByPromptRun.set(promptRunKey(group, index, payload), new Set(staleResourceUrls));
  log("debug", "Submitting prompt", collectDiagnostics(), group.id, index);
  await submitPrompt();
  group.submittedIndexes.add(index);
  group.submittedAtByIndex.set(index, Date.now());
  registerTileWaiter(group, index);
  revealGenerationAreaAfterSubmit(group, index, knownBeforeSubmit);
  return { knownBeforeSubmit };
}

async function ensureCanvasReady() {
  await closeUntitledSessionPanel();
  const workspaceError = flowWorkspaceError();
  if (workspaceError) throw new Error(workspaceError);
  const ready = await waitForComposerReady();
  if (!ready) {
    throw new Error(`Flow composer did not become ready. ${JSON.stringify(collectDiagnostics())}`);
  }
}

function flowWorkspaceError() {
  if (findNormalFlowComposerEditor()) return "";
  if (findFallbackComposerConfigButton() || findFallbackComposerSubmitButton()) return "";
  if (findNewProjectButton()) return openNewProjectMessage;
  if (isFlowProjectPage()) return "";
  return openNewProjectMessage;
}

async function waitForComposerReady() {
  const initial = composerReadyState();
  if (initial.ready) return true;

  log("debug", "Waiting for Flow composer controls to become ready", initial.diagnostics);
  return Boolean(await waitUntil(() => {
    const state = composerReadyState();
    if (state.ready) return true;
    return false;
  }, composerReadyWaitMs, 500));
}

function composerReadyState() {
  const editor = findNormalFlowComposerEditor();
  const config = findComposerConfigButton();
  const submit = findComposerSubmitButton();
  return {
    ready: Boolean((editor && config) || (config && submit)),
    diagnostics: {
      editor: editor ? describeElement(editor) : null,
      config: config ? describeElement(config) : null,
      submit: submit ? describeElement(submit) : null,
      href: location.href,
      isProjectPage: isFlowProjectPage()
    }
  };
}

async function closeUntitledSessionPanel() {
  const panel = findUntitledSessionPanel();
  if (!panel) return false;
  const closeButton = findUntitledSessionCloseButton(panel);
  if (!closeButton) {
    log("warn", "Untitled session panel is open but no close button was found", { panel: describeElement(panel) });
    return false;
  }
  log("debug", "Closing Untitled session panel", { panel: describeElement(panel), button: describeElement(closeButton) });
  await clickElement(closeButton);
  await waitUntil(() => !findUntitledSessionPanel(), 1800, 100);
  await sleep(150);
  return !findUntitledSessionPanel();
}

async function configureMode(payload: PromptPayload, options: { strictOutputCount?: boolean } = {}) {
  const strictOutputCount = options.strictOutputCount ?? true;
  const signature = configSignature(payload);
  await ensureComposerAgentOff();
  const existingConfig = findComposerConfigButton();
  const existingLabel = existingConfig ? elementLabel(existingConfig).toLowerCase().replace(/\s+/g, "") : "";
  if (lastConfigSignature === signature && configLooksCompatible(existingLabel, payload, strictOutputCount)) {
    log("debug", "Skipping unchanged Flow configuration", { signature, existing: existingLabel });
    return;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const opened = await openComposerConfiguration();
    if (!opened) {
      throw new Error("Could not open Flow composer settings. The composer may not be ready yet.");
    }
    const applied = await applyComposerChoices(payload, attempt + 1);
    const done = findButtonByText(["done", "close", "apply"]) ?? findFirst(flowSelectors.doneButtons);
    if (done) await clickElement(done);
    else await closeTransientFlowUi();

    await waitUntil(() => {
      const label = elementLabel(findComposerConfigButton() ?? document.body);
      return configLooksCompatible(label, payload, strictOutputCount) && requiredChoicesWereApplied(payload, applied);
    }, 3200, 150);

    const finalConfig = findComposerConfigButton();
    const finalLabel = finalConfig ? elementLabel(finalConfig) : "";
    if (configLooksCompatible(finalLabel, payload, strictOutputCount) && requiredChoicesWereApplied(payload, applied)) {
      lastConfigSignature = signature;
      return;
    }

    log(attempt < 3 ? "warn" : "error", "Flow settings not settled after apply pass", {
      attempt: attempt + 1,
      applied,
      strictOutputCount,
      expected: expectedConfigDetails(payload),
      finalConfig: finalConfig ? describeElement(finalConfig) : null,
      visibleOptions: findConfigPopoverOptions().slice(0, 30).map(describeElement)
    });
    await closeTransientFlowUi();
    await sleep(250);
  }

  const finalConfig = findComposerConfigButton();
  const finalLabel = finalConfig ? elementLabel(finalConfig) : "";
  throw new Error(`Flow settings did not apply. Current composer setting is "${finalLabel || "unknown"}".`);
}

async function applyComposerChoices(payload: PromptPayload, attempt: number) {
  const selectedMode = await clickAnyTextOption(modeAliases(payload.mode), { exact: false });
  const selectedVideoInput = isVideoOutputMode(payload.mode)
    ? await clickAnyTextOption(videoInputAliases(payload.mode), { exact: false })
    : false;
  const selectedImageModel = isImageOutputMode(payload.mode) ? await selectModel(modelForPayload(payload)) : false;
  const selectedAspect = await clickAnyTextOption(aspectAliases(effectiveAspectRatio(payload)), { exact: false });
  const selectedDuration = payload.mode.includes("video")
    ? await clickAnyTextOption([payload.videoDuration, payload.videoDuration.replace("s", "")], { exact: true })
    : false;
  if (isVideoOutputMode(payload.mode) && !selectedDuration) {
    log("warn", "Flow video duration option was not visible; continuing with Flow default", {
      requested: payload.videoDuration,
      mode: payload.mode,
      options: findConfigPopoverOptions().slice(0, 20).map(describeElement)
    });
  }
  const selectedCount = await clickAnyTextOption(outputCountAliases(payload.outputCount), { exact: true });
  const selectedVideoModel = isVideoOutputMode(payload.mode) ? await selectModel(modelForPayload(payload)) : false;
  const selectedModel = isVideoOutputMode(payload.mode) ? selectedVideoModel : selectedImageModel;
  const applied = { selectedMode, selectedVideoInput, selectedAspect, selectedModel, selectedDuration, selectedCount };
  log("debug", "Composer configuration choices applied", {
    attempt,
    ...applied,
    summary: findComposerConfigButton() ? describeElement(findComposerConfigButton()!) : null,
    options: findConfigPopoverOptions().slice(0, 20).map(describeElement)
  });
  return applied;
}

function requiredChoicesWereApplied(
  payload: PromptPayload,
  applied: {
    selectedMode: boolean;
    selectedVideoInput: boolean;
    selectedAspect: boolean;
    selectedModel: boolean;
    selectedDuration: boolean;
    selectedCount: boolean;
  }
) {
  if (isVideoOutputMode(payload.mode) && (!applied.selectedModel || !applied.selectedVideoInput)) return false;
  return true;
}

function expectedConfigDetails(payload: PromptPayload) {
  return {
    mode: payload.mode,
    aspectRatio: effectiveAspectRatio(payload),
    model: modelForPayload(payload),
    outputCount: payload.outputCount,
    videoDuration: payload.mode.includes("video") ? payload.videoDuration : undefined
  };
}

async function closeTransientFlowUi(groupId?: string, promptIndex?: number) {
  log("debug", "Closing transient Flow UI", undefined, groupId, promptIndex);
  await sendRuntimeMessage({ type: "SEND_KEY", key: "Escape", code: "Escape", keyCode: 27 }).catch(() => undefined);
  await sleep(120);
  await sendRuntimeMessage({ type: "SEND_KEY", key: "Escape", code: "Escape", keyCode: 27 }).catch(() => undefined);
  await sleep(120);
}

async function clearComposerAttachments(groupId?: string, promptIndex?: number) {
  const before = {
    mediaAttachments: countComposerAttachments(),
    pendingAttachments: countComposerPendingAttachmentControls()
  };
  if (before.mediaAttachments === 0 && before.pendingAttachments === 0) return;

  log("debug", "Clearing existing Flow composer attachments before image-to-video prompt", {
    ...before,
    composer: describeComposer()
  }, groupId, promptIndex);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const removeButton = findComposerAttachmentRemoveButton() ?? findComposerClearPromptButton();
    if (!removeButton) break;
    await clickElement(removeButton);
    await sleep(350);
  }

  await waitUntil(() => countComposerAttachments() === 0 && countComposerPendingAttachmentControls() === 0, 5000, 150);
  lastComposerAttachmentSignature = "";
}

async function ensureComposerAgentOff(groupId?: string, promptIndex?: number) {
  const agentButton = findComposerAgentButton();
  if (!agentButton) return;
  if (!isAgentButtonActive(agentButton)) {
    log("debug", "Flow Agent chip is already off", { button: describeElement(agentButton) }, groupId, promptIndex);
    return;
  }

  log("debug", "Turning off active Flow Agent chip", { button: describeElement(agentButton) }, groupId, promptIndex);
  await clickElement(agentButton);
  await waitUntil(() => {
    const current = findComposerAgentButton();
    return !current || !isAgentButtonActive(current);
  }, 1800, 100).catch(() => false);
  await sleep(120);
}

async function openComposerConfiguration() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await focusComposerArea();
    const configButton = await waitUntil(() => findComposerConfigButton(), composerControlReadyWaitMs, 250);
    if (!configButton) {
      log("warn", "Flow composer configuration button was not found", collectDiagnostics());
      return false;
    }
    log("debug", "Opening composer configuration", { attempt: attempt + 1, button: describeElement(configButton) });
    await clickElement(configButton);
    const opened = await waitUntil(() => findConfigPopoverOptions().length > 2, 1400, 100);
    if (opened) return true;
    await sleep(150);
  }
  log("warn", "Flow composer configuration did not expose options after clicking", collectDiagnostics());
  return false;
}

async function uploadPreparedImages(payload: PromptPayload, groupId?: string, promptIndex?: number) {
  const images = (payload.imageIds || []).map((id) => preparedImages.get(id)).filter(Boolean) as PreparedImage[];
  if (images.length === 0) return { requiredCount: 0, allowReadyFallback: false };

  const before = countComposerAttachments();
  const signature = imageAttachmentSignature(images);
  log("debug", "Preparing Flow image attachment", {
    mode: payload.mode,
    imageCount: images.length,
    imageNames: images.map((image) => image.name),
    attachmentsBefore: before,
    composer: describeComposer()
  });

  if (payload.mode === "image-to-video" && before >= images.length && lastComposerAttachmentSignature === signature) {
    log("debug", "Reusing existing Flow image attachment", {
      imageNames: images.map((image) => image.name),
      attachmentsBefore: before,
      composer: describeComposer()
    });
    return { requiredCount: before, allowReadyFallback: false };
  }

  const libraryResult = await attachImagesThroughFlowLibrary(images, before);
  if (libraryResult.attached) return rememberAttachmentState(signature, attachmentStateAfterUpload(before, images.length));
  if (libraryResult.started) {
    await closeTransientFlowUi();
  }
  if (await pasteImagesIntoComposer(images, before, groupId, promptIndex)) return rememberAttachmentState(signature, attachmentStateAfterUpload(before, images.length));

  const transfer = new DataTransfer();
  for (const image of images) {
    transfer.items.add(await preparedImageToPngFile(image));
  }

  const passiveInput = findUploadInput();
  if (passiveInput) {
    log("debug", "Attaching image through existing Flow file input without opening file picker", {
      imageNames: images.map((image) => image.name),
      input: describeElement(passiveInput)
    });
    await attachFilesToInput(passiveInput, transfer);
  } else {
    log("debug", "Trying composer drag/drop image attachment without opening file picker", {
      attachmentsBefore: before,
      composer: describeComposer()
    });
    await closeTransientFlowUi();
    await dropFilesOnComposer(transfer);
  }

  const attached = await waitForComposerAttachmentReady(before + images.length, groupId, promptIndex);
  if (!attached) {
    log("warn", "Flow did not show image attachments without the native file picker", {
      input: passiveInput ? describeElement(passiveInput) : null,
      attachmentsBefore: before,
      attachmentsNow: countComposerAttachments(),
      composer: describeComposer()
    }, groupId, promptIndex);
    if (passiveInput) {
      await dropFilesOnComposer(transfer);
      await waitForComposerAttachmentReady(before + images.length, groupId, promptIndex);
    }
  }

  const after = countComposerAttachments();
  log(after > before || createButtonHasMediaReady() ? "debug" : "warn", "Flow image attachment finished", {
    attachmentsBefore: before,
    attachmentsAfter: after,
    submit: findComposerSubmitButton() ? describeElement(findComposerSubmitButton()!) : null,
    composer: describeComposer()
  });

  if (after <= before && !createButtonHasMediaReady()) {
    throw new Error("Flow did not attach the selected image without opening the file picker. Add the image to Flow Uploads first, or try pasting it into the composer.");
  }
  return rememberAttachmentState(signature, attachmentStateAfterUpload(before, images.length));
}

function rememberAttachmentState(signature: string, state: AttachmentState) {
  lastComposerAttachmentSignature = signature;
  return state;
}

function imageAttachmentSignature(images: PreparedImage[]) {
  return images
    .map((image) => `${image.id}:${image.name}:${image.mimeType}:${image.dataUrl.length}`)
    .join("|");
}

function attachmentStateAfterUpload(attachmentsBefore: number, expectedImages: number): AttachmentState {
  const currentAttachments = countComposerAttachments();
  const addedAttachments = Math.max(0, currentAttachments - attachmentsBefore);
  return {
    requiredCount: addedAttachments > 0 ? attachmentsBefore + Math.min(addedAttachments, expectedImages) : 1,
    allowReadyFallback: addedAttachments === 0 && createButtonHasMediaReady()
  };
}

async function attachImagesThroughFlowLibrary(images: PreparedImage[], attachmentsBefore: number): Promise<{ attached: boolean; started: boolean }> {
  let started = false;
  for (const image of images) {
    const libraryOpened = await openFlowMediaLibrary();
    if (!libraryOpened) {
      log("warn", "Flow uploaded-media picker could not be opened", {
        image: image.name,
        composer: describeComposer(),
        addButtonCandidates: describeComposerAddButtonCandidates(),
        pickerRootCandidates: findAssetPickerCandidates()
      });
      return { attached: false, started };
    }
    started = true;

    if (await selectUploadedMediaItem(image.name)) {
      log("debug", "Selected existing Flow uploaded media", { image: image.name });
      if (!(await confirmAssetPickerSelection())) {
        log("warn", "Flow asset was selected but Add to Prompt was not available", {
          image: image.name,
          pickerRoot: describeAssetPickerRoot(),
          picker: describeFlowMediaPicker()
        });
        return { attached: false, started };
      }
      await sleep(800);
      continue;
    }

    log("debug", "Required image was not already in Flow media library; skipping Upload media to avoid native file picker", {
      image: image.name,
      pickerRoot: describeAssetPickerRoot(),
      picker: describeFlowMediaPicker()
    });
    return { attached: false, started };
  }

  const attached = await waitUntil(
    () => countComposerAttachments() >= attachmentsBefore + images.length || createButtonHasMediaReady(),
    12000,
    250
  );
  const attachmentsAfter = countComposerAttachments();
  log(attached ? "debug" : "warn", "Flow media library attachment finished", {
    attachmentsBefore,
    attachmentsAfter,
    expectedImages: images.map((image) => image.name),
    submit: findComposerSubmitButton() ? describeElement(findComposerSubmitButton()!) : null,
    composer: describeComposer(),
    pickerRoot: describeAssetPickerRoot(),
    picker: describeFlowMediaPicker()
  });
  return { attached: Boolean(attached), started };
}

async function openFlowMediaLibrary() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existingPicker = findAssetPickerRoot();
    if (existingPicker) return true;

    const addButton = findComposerAddMediaButton();
    if (addButton) {
      log("debug", "Opening Flow media picker", { attempt: attempt + 1, button: describeElement(addButton) });
      await clickElement(addButton);
      const opened = await waitUntil(() => findAssetPickerRoot(), 1600, 100);
      if (opened) return true;
    }

    const libraryOption = findFlowMediaLibraryOption();
    if (libraryOption) {
      log("debug", "Opening Flow uploaded-media library", describeElement(libraryOption));
      await clickElement(libraryOption);
      const opened = await waitUntil(() => findAssetPickerRoot(), 1600, 100);
      if (opened) return true;
    }
  }
  return false;
}

async function selectUploadedMediaItem(name: string) {
  await searchFlowMediaLibrary(name);
  const item = await waitUntil(() => findUploadedMediaItem(name), 8000, 250);
  if (!item) return false;
  await clickElement(item);
  return true;
}

async function waitForPreparedImageInFlowLibrary(image: PreparedImage, timeoutMs: number, groupId?: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const libraryOpened = await openFlowMediaLibrary();
    if (libraryOpened) {
      await searchFlowMediaLibrary(image.name);
      const item = await waitUntil(() => findUploadedMediaItem(image.name), 5000, 350);
      if (item) {
        log("debug", "Staged image is visible in Flow uploaded media", {
          image: image.name,
          waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
          pickerRoot: describeAssetPickerRoot()
        }, groupId);
        return true;
      }
    } else {
      log("debug", "Waiting for Flow uploaded-media picker while staging image", {
        image: image.name,
        composer: describeComposer(),
        addButtonCandidates: describeComposerAddButtonCandidates()
      }, groupId);
    }

    await closeTransientFlowUi(groupId);
    await sleep(1500);
  }

  log("warn", "Staged image did not appear in Flow uploaded media", {
    image: image.name,
    waitedSeconds: Math.round(timeoutMs / 1000),
    pickerRoot: describeAssetPickerRoot(),
    picker: describeFlowMediaPicker()
  }, groupId);
  return false;
}

async function searchFlowMediaLibrary(name: string) {
  const input = findMediaSearchInput();
  if (!input) return false;
  const query = mediaSearchTerm(name);
  input.focus();
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: query, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);
  return true;
}

function findFlowMediaLibraryOption() {
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='menuitem'], [role='option'], div, span")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const label = normalizeOptionText(elementLabel(element));
      if (!label || label.length > 100) return false;
      return /view uploaded media|uploaded media|media library|drive_folder_upload/i.test(label);
    })
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function findAssetPickerRoot() {
  const candidates = [...document.querySelectorAll<HTMLElement>("[role='dialog'], [data-side='top'], div")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 260) return false;
      if (rect.width > window.innerWidth * 0.85 || rect.height > window.innerHeight * 0.9) return false;
      const label = normalizeOptionText(elementLabel(element));
      return /search assets|add to prompt|upload media/.test(label);
    })
    .map((element) => {
      const label = normalizeOptionText(elementLabel(element));
      const rect = element.getBoundingClientRect();
      const topLayerBonus = element.getAttribute("role") === "dialog" || element.hasAttribute("data-side") ? 5000 : 0;
      const confirmBonus = /add to prompt/.test(label) ? 3000 : 0;
      const searchBonus = /search assets/.test(label) ? 1500 : 0;
      const uploadBonus = /upload media/.test(label) ? 500 : 0;
      const pagePenalty = /google flow - ai creative studio|arrow_backgo back|settings_2view settings/.test(label) ? 6000 : 0;
      const area = rect.width * rect.height;
      return { element, score: topLayerBonus + confirmBonus + searchBonus + uploadBonus - pagePenalty - area / 10000 };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.element);
  return candidates[0] ?? null;
}

function describeAssetPickerRoot() {
  const root = findAssetPickerRoot();
  if (!root) return null;
  const rect = root.getBoundingClientRect();
  return {
    ...describeElement(root),
    text: elementLabel(root).replace(/\s+/g, " ").trim().slice(0, 260),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    area: Math.round(rect.width * rect.height)
  };
}

function findAssetPickerCandidates() {
  return [...document.querySelectorAll<HTMLElement>("[role='dialog'], [data-side='top'], div")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 320 && rect.height >= 260 && /search assets|add to prompt|upload media/i.test(elementLabel(element));
    })
    .slice(-12)
    .map(describeElement);
}

function findMediaSearchInput() {
  const scope = findAssetPickerRoot() ?? document;
  return [...scope.querySelectorAll<HTMLInputElement>("input")]
    .filter((input) => {
      if (!isVisible(input)) return false;
      const label = elementLabel(input).toLowerCase();
      const type = (input.type || "").toLowerCase();
      return type === "search" || /search|uploaded|media|asset/.test(label);
    })
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function findUploadedMediaItem(name?: string) {
  const scope = findAssetPickerRoot() ?? document;
  const wanted = normalizeMediaName(name || "");
  const stem = normalizeMediaName((name || "").replace(/\.[^.]+$/, ""));
  const candidates = [...scope.querySelectorAll<HTMLElement>(
    "button, [role='button'], [role='option'], [role='gridcell'], [data-testid], div, img"
  )]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) return false;
      if (isOversizedMediaPickerContainer(element, rect)) return false;
      if (name && rect.top < 60) return false;
      const label = normalizeMediaName(elementLabel(element));
      if (!label) return false;
      if (!name) return /png|jpe?g|webp|image|uploaded|media/.test(label);
      return label.includes(wanted) || (stem.length >= 3 && label.includes(stem));
    })
    .map((element) => {
      const label = normalizeMediaName(elementLabel(element));
      const exact = wanted && label.includes(wanted) ? 1000 : 0;
      const tag = element.tagName.toLowerCase();
      const rect = element.getBoundingClientRect();
      const cardBonus = /button|option|gridcell/.test(element.getAttribute("role") || "") || tag === "button" ? 500 : 0;
      const mediaBonus = element.querySelector("img") ? 300 : tag === "img" ? 80 : 0;
      const usefulAreaBonus = Math.min(240, Math.round((Math.min(rect.width, 360) * Math.min(rect.height, 260)) / 1000));
      const hugePenalty = rect.width > 760 || rect.height > 560 ? 1200 : 0;
      const depthBonus = domDepth(element) * 8;
      return { element, score: exact + cardBonus + mediaBonus + usefulAreaBonus + depthBonus + optionScore(element) - hugePenalty };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.element ?? null;
}

function isOversizedMediaPickerContainer(element: HTMLElement, rect: DOMRect) {
  const role = element.getAttribute("role") || "";
  const tag = element.tagName.toLowerCase();
  if (tag === "img" || tag === "button" || /button|option|gridcell/.test(role)) return false;
  const viewportWide = rect.width > window.innerWidth * 0.65;
  const pickerWide = rect.width > 760;
  const pickerTall = rect.height > 560;
  return viewportWide || pickerWide || pickerTall;
}

function domDepth(element: Element) {
  let depth = 0;
  for (let current = element.parentElement; current; current = current.parentElement) depth += 1;
  return depth;
}

async function confirmAssetPickerSelection() {
  const pickerRoot = findAssetPickerRoot();
  const confirmButton = await waitUntil(() => {
    const button =
    findButtonByText(["add to prompt"]) ??
    findFirstButtonInScope(pickerRoot, /add to prompt/i) ??
    findFirstButtonInScope(pickerRoot, /^done$/i) ??
    findButtonByText(["done"]);
    return button && !isDisabled(button) ? button : null;
  }, 3500, 200);
  if (!confirmButton || isDisabled(confirmButton)) return false;
  log("debug", "Confirming Flow asset picker selection", describeElement(confirmButton));
  await clickElement(confirmButton);
  await sleep(800);
  return true;
}

function findFirstButtonInScope(scope: Element | null, pattern: RegExp) {
  if (!scope) return null;
  return [...scope.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((element) => isVisible(element) && pattern.test(elementLabel(element)))
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function normalizeMediaName(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function mediaSearchTerm(name: string) {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return stem || name;
}

function describeFlowMediaPicker() {
  return {
    search: findMediaSearchInput() ? describeElement(findMediaSearchInput()!) : null,
    uploadInput: findUploadInput() ? describeElement(findUploadInput()!) : null,
    uploadButton: findUploadMediaButton() ? describeElement(findUploadMediaButton()!) : null,
    libraryOption: findFlowMediaLibraryOption() ? describeElement(findFlowMediaLibraryOption()!) : null,
    mediaCandidates: [...document.querySelectorAll<HTMLElement>("img, button, [role='button'], [role='option'], [role='gridcell']")]
      .filter(isVisible)
      .slice(-25)
      .map(describeElement)
  };
}

async function pasteImagesIntoComposer(images: PreparedImage[], attachmentsBefore: number, groupId?: string, promptIndex?: number) {
  if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
    log("warn", "Clipboard image paste is not available in this browser context");
    return false;
  }

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const file = await preparedImageToPngFile(image);
    const expectedAttachments = attachmentsBefore + index + 1;
    try {
      const target = findComposerContainer() ?? findNormalFlowComposerEditor();
      if (target) await clickElement(target);
      await sleep(150);
      if (target) {
        dispatchImagePaste(target, file);
        await sleep(500);
      }
      if (countComposerAttachments() < expectedAttachments && !createButtonHasMediaReady()) {
        await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
      }
      await sendRuntimeMessage({ type: "SEND_KEY", key: "v", code: "KeyV", keyCode: 86, modifiers: 4 });
      log("debug", "Pasted image into Flow composer", { image: image.name, mimeType: file.type, composer: describeComposer() });
      const attached = await waitForComposerAttachmentReady(expectedAttachments, groupId, promptIndex);
      if (!attached) return false;
    } catch (error) {
      log("warn", "Clipboard image paste failed", { image: image.name, error: errorToText(error) }, groupId, promptIndex);
      return false;
    }
  }

  const after = countComposerAttachments();
  log(after > attachmentsBefore || createButtonHasMediaReady() ? "debug" : "warn", "Flow image paste attachment finished", {
    attachmentsBefore,
    attachmentsAfter: after,
    submit: findComposerSubmitButton() ? describeElement(findComposerSubmitButton()!) : null,
    composer: describeComposer()
  });
  return after > attachmentsBefore || createButtonHasMediaReady();
}

function dispatchImagePaste(target: Element, file: File) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const eventTargets = Array.from(new Set([
    findNormalFlowComposerEditor(),
    target,
    findComposerContainer(),
    document.activeElement,
    document.body
  ].filter(Boolean) as Element[]));

  for (const eventTarget of eventTargets) {
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    });
    Object.defineProperty(event, "clipboardData", { configurable: true, value: transfer });
    eventTarget.dispatchEvent(event);
  }
}

async function waitForComposerAttachmentReady(expectedAttachments: number, groupId?: string, promptIndex?: number) {
  const isReady = () => countComposerAttachments() >= expectedAttachments || createButtonHasMediaReady();
  if (await waitUntil(isReady, initialAttachmentReadyWaitMs, 250)) return true;

  const pendingAttachments = countComposerPendingAttachmentControls();
  if (pendingAttachments <= 0) return false;

  log("debug", "Waiting longer for Flow to finish processing pasted image attachment", {
    expectedAttachments,
    currentAttachments: countComposerAttachments(),
    pendingAttachments,
    composer: describeComposer()
  }, groupId, promptIndex);
  return Boolean(await waitUntil(isReady, pendingAttachmentReadyWaitMs, 500));
}

function findUploadInput() {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  return inputs
    .filter((input) => {
      const accept = `${input.accept || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
      return !accept || /image|\*|png|jpg|jpeg|webp|gif/.test(accept);
    })
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function findUploadMediaButton() {
  const pickerRoot = findAssetPickerRoot();
  if (!pickerRoot) return null;
  return [...pickerRoot.querySelectorAll<HTMLElement>("button, [role='button'], [role='menuitem'], [role='option'], label")]
    .filter((element) => {
      if (!isVisible(element) || isDisabled(element)) return false;
      const label = normalizeOptionText(elementLabel(element));
      if (!label || label.length > 120) return false;
      const compact = label.replace(/\s+/g, "");
      const isUploadAction = /\bupload media\b|from computer|select files?|browse files?/.test(label) || compact.includes("uploaduploadmedia");
      return isUploadAction && !/download|add to prompt|uploads$/.test(label);
    })
    .sort((a, b) => uploadButtonScore(b) - uploadButtonScore(a))[0] ?? null;
}

function uploadButtonScore(element: HTMLElement) {
  const label = normalizeOptionText(elementLabel(element));
  const rect = element.getBoundingClientRect();
  const tag = element.tagName.toLowerCase();
  const actionLabelBonus = /\bupload media\b/.test(label) || label.replace(/\s+/g, "").includes("uploaduploadmedia") ? 1000 : 0;
  const buttonBonus = tag === "button" || /button|menuitem|option/.test(element.getAttribute("role") || "") ? 400 : 0;
  const usefulSizeBonus = rect.width >= 70 && rect.width <= 260 && rect.height >= 24 && rect.height <= 80 ? 250 : 0;
  const hugePenalty = rect.width > 420 || rect.height > 140 ? 900 : 0;
  return actionLabelBonus + buttonBonus + usefulSizeBonus + optionScore(element) - hugePenalty;
}

async function attachFilesToInput(input: HTMLInputElement, transfer: DataTransfer) {
  try {
    input.files = transfer.files;
  } catch {
    Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
  }
  input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(1500);
}

async function dropFilesOnComposer(transfer: DataTransfer) {
  const target = findComposerContainer() ?? findNormalFlowComposerEditor() ?? document.body;
  const rect = target.getBoundingClientRect();
  const eventInit: DragEventInit = {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  };
  target.dispatchEvent(new DragEvent("dragenter", eventInit));
  target.dispatchEvent(new DragEvent("dragover", eventInit));
  target.dispatchEvent(new DragEvent("drop", eventInit));
  await sleep(1500);
}

async function fillPrompt(prompt: string) {
  const editor = await waitUntil(() => {
    const current = findNormalFlowComposerEditor();
    return current && isInViewport(current) ? current : null;
  }, composerControlReadyWaitMs, 250);
  if (!editor) throw new Error("Could not find Flow prompt editor.");

  await clickElement(editor);
  selectEditorContents(editor);
  const inserted = await sendRuntimeMessage({ type: "INSERT_TEXT", text: prompt });
  if (!inserted.success) {
    setEditorText(editor, prompt);
  }
  await sleep(120);
  await sendRuntimeMessage({ type: "INSERT_TEXT", text: " " }).catch(() => undefined);
  await sleep(40);
  await sendRuntimeMessage({ type: "SEND_KEY", key: "Backspace", code: "Backspace", keyCode: 8 }).catch(() => undefined);
  await sleep(300);
  log("debug", "Prompt fill complete", { editor: describeElement(editor), submit: findComposerSubmitButton() ? describeElement(findComposerSubmitButton()!) : null });
}

function selectEditorContents(editor: HTMLElement) {
  if (isTextInputEditor(editor)) {
    focusElementWithoutScrolling(editor);
    editor.select();
    return;
  }
  focusElementWithoutScrolling(editor);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function ensureRequiredAttachments(attachmentState: AttachmentState) {
  if (attachmentState.requiredCount <= 0) return;
  const currentAttachments = countComposerAttachments();
  if (currentAttachments < attachmentState.requiredCount && !(attachmentState.allowReadyFallback && createButtonHasMediaReady())) {
    throw new Error(`Flow removed the selected image before submit. Expected ${attachmentState.requiredCount} attachment, found ${currentAttachments}.`);
  }
}

async function submitPrompt() {
  await focusComposerArea();
  const submit = await waitUntil(() => findComposerSubmitButton(), composerControlReadyWaitMs, 250);
  if (!submit) {
    log("warn", "Submit button not found, falling back to Enter key", collectDiagnostics());
    await sendRuntimeMessage({ type: "SEND_KEY", key: "Enter", code: "Enter", keyCode: 13 });
    await sleep(1200);
    return;
  }

  log("debug", "Found composer submit button", describeElement(submit));
  if (isDisabled(submit)) {
    log("warn", "Flow Create button is disabled", {
      reason: inferDisabledCreateReason(),
      submit: describeElement(submit),
      diagnostics: collectDiagnostics()
    });
    throw new Error("Flow Create button is disabled.");
  }

  await clickElement(submit);
  await sleep(1200);
}

async function waitForTileIds(payload: PromptPayload, group: RunningGroup, index: number, knownBefore: string[]) {
  const expectedCount = payload.outputCount;
  const timeoutMs = tileAppearTimeoutMs(payload, group);
  const startedAt = Date.now();
  let lastRevealAt = 0;
  let revealPass = 0;
  const staleResourceUrls = staleResourceUrlsByPromptRun.get(promptRunKey(group, index, payload)) ?? new Set<string>();
  log("debug", "Waiting for new generation tiles", {
    expectedCount,
    knownBefore,
    timeoutSeconds: Math.round(timeoutMs / 1000)
  }, group.id, index);
  const tileIds = await waitUntil(() => {
    const observedTileIds = rememberObservedTileIds(group, collectTileIds());
    const candidates = observedTileIds
      .filter((id) => !knownBefore.includes(id) && tileOwnerAllows(group, id, index))
      .filter((id) => tileLooksLikeNewPromptResult(id, payload));
    const promptMatches = candidates.filter((id) => {
      const status = describeTileStatus(id);
      return Boolean(status && tileTextLooksRelatedToPrompt(status.text, payload.prompt));
    });
    const genericCandidates = candidates.filter((id) => tileLooksGenericClaimable(id));
    rememberTileCandidates(group, index, genericCandidates);
    const rememberedGenericCandidates = rememberedTileCandidates(group, index)
      .filter((id) => !knownBefore.includes(id) && tileOwnerAllows(group, id, index) && tileLooksRememberedClaimable(id, payload));
    const completedFallbackCandidates = tileWaiterCanClaimGeneric(group, index)
      ? completedTileFallbackCandidates(group, index, knownBefore, payload)
      : [];
    let current: string[] = [];
    if (promptMatches.length >= expectedCount) {
      current = promptMatches;
    } else if (tileWaiterCanClaimGeneric(group, index)) {
      current = rememberedGenericCandidates.length >= expectedCount
        ? rememberedGenericCandidates
        : completedFallbackCandidates;
    }
    let claimReasonForSelection: TileOwnerReason | ((tileId: string) => TileOwnerReason) =
      (tileId) => tileClaimReasonForWaitSelection(group, index, payload, tileId);
    if (current.length < expectedCount && shouldRunTimedImageProbe(payload, group, index, startedAt)) {
      const readyTimedCandidates = timedImageProbeCandidates(
        group,
        index,
        knownBefore,
        payload,
        observedTileIds,
        staleResourceUrls,
        { requireComplete: true, requireDownloadableUrl: true }
      );
      const activeTimedCandidates = readyTimedCandidates.length >= expectedCount
        ? []
        : timedImageProbeCandidates(group, index, knownBefore, payload, observedTileIds, staleResourceUrls, {
            requireComplete: false,
            requireDownloadableUrl: false
          });
      const timedCandidates = readyTimedCandidates.length >= expectedCount ? readyTimedCandidates : activeTimedCandidates;
      if (timedCandidates.length >= expectedCount) {
        current = timedCandidates;
        claimReasonForSelection = "timed-generated-card";
        log("info", readyTimedCandidates.length >= expectedCount
          ? "Timed image check found generated Flow card"
          : "Timed image check found active Flow card", {
          waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
          tileIds: timedCandidates.slice(0, expectedCount),
          directUrls: readyTimedCandidates.length,
          statuses: timedCandidates.slice(0, expectedCount)
            .map((tileId) => describeTileStatus(tileId))
            .filter(Boolean)
        }, group.id, index);
      } else {
        log("warn", "Timed image check did not find a generated Flow card", {
          waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
          knownBeforeCount: knownBefore.length,
          staleResourceUrlsIgnored: staleResourceUrls.size,
          freshStatuses: timedImageProbeStatuses(group, index, knownBefore, payload, observedTileIds).slice(0, 12)
        }, group.id, index);
        throw new Error("Flow image was not generated after the wait window.");
      }
    }
    if (current.length < expectedCount && Date.now() - lastRevealAt >= generationRevealIntervalMs) {
      lastRevealAt = Date.now();
      revealPass += 1;
      revealGenerationAreaDuringWait(group, index, knownBefore, payload, observedTileIds, revealPass);
    }
    const waitingPercentage = current.length > 0 ? Math.min(20, current.length * 10) : Math.max(10, group.results[index]?.percentage ?? 0);
    updateResult(group, index, { percentage: waitingPercentage });
    if (current.length < expectedCount) return null;
    const selected = sortTileIdsForPromptSelection(current, payload, group, index).slice(0, expectedCount);
    claimTileIds(group, index, selected, claimReasonForSelection);
    return selected;
  }, timeoutMs, 300);

  if (!tileIds) {
    log("warn", "Generation tile did not appear", collectDiagnostics(), group.id, index);
    throw new Error("Generation tile did not appear.");
  }
  claimTileIds(group, index, tileIds, (tileId) => tileClaimReasonForWaitSelection(group, index, payload, tileId));
  await sleep(1800);
  const refreshedTileIds = refreshedPromptTileIds(group, index, payload, tileIds, {
    knownBefore,
    preferDownloadableImages: !payload.mode.includes("video")
  });
  const finalTileIds = refreshedTileIds.length >= expectedCount ? refreshedTileIds.slice(0, expectedCount) : tileIds;
  claimTileIds(group, index, finalTileIds, (tileId) => tileClaimReasonForWaitSelection(group, index, payload, tileId));
  revealTiles(finalTileIds);
  const ignoredTileIds = rememberObservedTileIds(group, collectTileIds())
    .filter((id) => !knownBefore.includes(id) && !finalTileIds.includes(id));
  log("info", "Generation tiles appeared", { tileIds: finalTileIds, initialTileIds: tileIds, ignoredTileIds }, group.id, index);
  return finalTileIds;
}

function tileAppearTimeoutMs(payload: PromptPayload, group: RunningGroup) {
  if (payload.mode.includes("video")) return 2 * 60 * 1000;
  return group.concurrentPrompts > 1 ? 3 * 60 * 1000 : 2 * 60 * 1000;
}

function sortTileIdsForPromptSelection(tileIds: string[], payload: PromptPayload, group: RunningGroup, index: number) {
  return [...tileIds].sort((a, b) => promptSelectionTileScore(b, payload, group, index) -
    promptSelectionTileScore(a, payload, group, index));
}

function promptSelectionTileScore(tileId: string, payload: PromptPayload, group: RunningGroup, index: number) {
  const status = describeTileStatus(tileId);
  const promptMatch = status && tileTextLooksRelatedToPrompt(status.text, payload.prompt);
  const complete = status && isTileComplete(status);
  const playableVideo = status && canUseStatusForVideoDownload(status);
  const claim = group.tileOwnerClaims.get(tileId);
  const claimRank = claim?.index === index ? tileOwnerReasonRank(claim.reason) : 0;
  return (
    (promptMatch ? 1_000_000_000 : 0) +
    (playableVideo ? 100_000_000 : 0) +
    (complete ? 10_000_000 : 0) +
    claimRank * 100_000 +
    visualAgeScore(tileId)
  );
}

function revealGenerationAreaAfterSubmit(group: RunningGroup, index: number, knownBefore: string[]) {
  const observedTileIds = rememberObservedTileIds(group, collectTileIds());
  const newVisibleTileIds = observedTileIds
    .filter((tileId) => !knownBefore.includes(tileId) && tileOwnerAllows(group, tileId, index))
    .filter((tileId) => {
      const status = describeTileStatus(tileId);
      return Boolean(status && !status.failed && (isTileStillGenerating(status) || tileLooksGenericClaimable(tileId)));
    });
  if (revealTiles(newVisibleTileIds)) return;
  scrollFlowOutputAreaUpward();
}

function revealGenerationAreaDuringWait(
  group: RunningGroup,
  index: number,
  knownBefore: string[],
  payload: PromptPayload,
  observedTileIds: string[],
  pass: number
) {
  const activeOrMatchingTileIds = observedTileIds
    .filter((tileId) => !knownBefore.includes(tileId) && tileOwnerAllows(group, tileId, index))
    .filter((tileId) => {
      const status = describeTileStatus(tileId);
      if (!status || status.failed) return false;
      if (tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return true;
      return isTileStillGenerating(status) || tileLooksGenericClaimable(tileId);
    });

  if (revealTiles(activeOrMatchingTileIds)) return;

  const scrolled = scrollFlowOutputAreaUpward();
  if (scrolled && (pass === 1 || pass % 4 === 0)) {
    log("debug", "Revealing Flow output area while waiting for generation card", {
      promptIndex: index,
      pass,
      knownBeforeCount: knownBefore.length,
      observedCount: observedTileIds.length
    }, group.id, index);
  }
}

function revealTiles(tileIds: string[]) {
  for (const tileId of tileIds) {
    const tile = tileElementForId(tileId);
    if (!tile || !isVisible(tile)) continue;
    tile.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  }
  return false;
}

function scrollFlowOutputAreaUpward() {
  const distance = -Math.max(240, Math.round(window.innerHeight * 0.85));
  let scrolled = false;
  for (const container of flowOutputScrollContainers()) {
    const before = container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const next = Math.max(0, Math.min(maxScrollTop, before + distance));
    if (Math.abs(next - before) < 2) continue;
    container.scrollTop = next;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    scrolled = true;
  }
  return scrolled;
}

function flowOutputScrollContainers() {
  const root = document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement;
  return uniqueElements([
    root,
    ...deepQueryAll<HTMLElement>("main, [role='main'], section, div")
  ])
    .filter((element) => {
      if (!isVisible(element) && element !== root) return false;
      if (element.scrollHeight <= element.clientHeight + 80) return false;
      const rect = element.getBoundingClientRect();
      if (element !== root && (rect.width < 360 || rect.height < 260)) return false;
      if (element.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
      return true;
    })
    .map((element) => ({ element, score: scrollContainerScore(element) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.element);
}

function scrollContainerScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const rootBonus = element === document.scrollingElement || element === document.documentElement ? 2000 : 0;
  const mediaCount = deepQueryAll<HTMLElement>("img[src], video, canvas", element)
    .filter((media) => isVisible(media))
    .slice(0, 20)
    .length;
  return rootBonus + mediaCount * 250 + Math.min(1200, Math.round((rect.width * rect.height) / 1000));
}

async function waitForResources(tileIds: string[], payload: PromptPayload, group: RunningGroup, index: number) {
  const requestedQuality = payload.autoDownloadResourceQuality;
  if (requestedQuality === "no-download") return [];
  return payload.mode.includes("video")
    ? waitForVideoResources(tileIds, payload, group, index)
    : waitForImageResources(tileIds, payload, group, index);
}

async function waitForImageResources(tileIds: string[], payload: PromptPayload, group: RunningGroup, index: number) {
  return waitForMediaResources(tileIds, payload, group, index, false);
}

async function waitForVideoResources(tileIds: string[], payload: PromptPayload, group: RunningGroup, index: number) {
  return waitForMediaResources(tileIds, payload, group, index, true);
}

async function waitForMediaResources(
  tileIds: string[],
  payload: PromptPayload,
  group: RunningGroup,
  index: number,
  preferVideo: boolean
) {
  const staleResourceUrls = staleResourceUrlsByPromptRun.get(promptRunKey(group, index, payload)) ?? new Set<string>();
  const timeoutMs = preferVideo ? 12 * 60 * 1000 : 90 * 1000;
  const startedAt = Date.now();
  const trackedTileIds = new Set(tileIds);
  const failureGraceMs = preferVideo ? videoFailureGraceMs : imageFailureGraceMs;
  let firstFailureAt = 0;
  let loggedEarlyVideoUrl = false;
  let loggedCompletedVideoWithoutUrl = false;
  let completedVideoWithoutUrlAt = 0;
  let videoResourceSignature = "";

  while (Date.now() - startedAt < timeoutMs) {
    rememberObservedTileIds(group, collectTileIds());
    const knownRelatedTileIds = [...trackedTileIds];
    const relatedTileIds = unique([
      ...collectRelatedTileIds(group, index, payload, knownRelatedTileIds),
      ...refreshedPromptTileIds(group, index, payload, knownRelatedTileIds, {
        preferDownloadableImages: !preferVideo
      })
    ]);
    for (const tileId of relatedTileIds) {
      if (!tileOwnerAllows(group, tileId, index)) continue;
      trackedTileIds.add(tileId);
      claimTileIds(group, index, [tileId], relatedTileClaimReason(group, index, payload, tileId, knownRelatedTileIds));
    }

    const currentTileIds = [...trackedTileIds];
    const tileResourceUrls = unique(currentTileIds.flatMap((tileId) => resourceUrlsForTile(tileId, preferVideo)));
    const statuses = currentTileIds.map((tileId) => describeTileStatus(tileId)).filter(Boolean) as TileStatus[];
    const activeStatuses = statuses.filter(isTileStillGenerating);
    const recoveryStatuses = activeStatuses.length === 0 && preferVideo
      ? finalUnclaimedVideoCardStatuses(group, index, payload)
      : [];
    const completedStatuses = activeStatuses.length === 0
      ? statuses
        .filter((status) => isTileComplete(status) && (!preferVideo || canUseStatusForVideoDownload(status)))
        .concat(recoveryStatuses)
        .filter(uniqueStatusByTileId)
      : [];
    const networkVideoUrls = preferVideo
      ? await collectNetworkVideoResourceUrls(group, index, payload, staleResourceUrls, {
        requirePromptMatch: true,
        requireStrictPromptMatch: true,
        contextLabels: videoContextLabelsForStatuses(completedStatuses)
      })
      : [];
    const visible = unique([...tileResourceUrls, ...networkVideoUrls]);
    const found = visible.filter((url) => !staleResourceUrls.has(url));
    const staleFound = visible.length - found.length;
    if (found.length >= payload.outputCount) {
      if (!preferVideo || completedStatuses.length >= payload.outputCount) {
        return waitForDownloadReadiness(currentTileIds, found, staleResourceUrls, payload, group, index, statuses);
      }
      const signature = found.slice(0, payload.outputCount).join("\n");
      if (signature !== videoResourceSignature) videoResourceSignature = signature;
      if (!loggedEarlyVideoUrl) {
        loggedEarlyVideoUrl = true;
        log("debug", "Video media URL appeared before tile finished; waiting for completed card", {
          tileIds: currentTileIds,
          found: found.length,
          staleIgnored: staleFound,
          statuses
        }, group.id, index);
      }
    }

    const failed = statuses.filter((status) => status.failed);
    const activeOrPlayable = statuses.some((status) => !status.failed && (status.generating || status.playable || (status.progress ?? 0) > 0));
    if (failed.length > 0 && !activeOrPlayable && found.length === 0) {
      if (Date.now() - startedAt < failureGraceMs) {
        if (!firstFailureAt) {
          firstFailureAt = Date.now();
          log("warn", "Flow reported failed generation tile; waiting before retry", {
            tileIds: currentTileIds,
            failed,
            mode: payload.mode,
            graceSeconds: Math.round(failureGraceMs / 1000)
          }, group.id, index);
        }
        updateResult(group, index, {
          percentage: Math.max(25, Math.min(45, Math.round(((Date.now() - startedAt) / failureGraceMs) * 45))),
          error: "Flow reported an early generation failure; waiting to confirm before retrying."
        });
        await sleep(preferVideo ? 5000 : 1500);
        continue;
      }
      log("warn", "Flow generation failed", { tileIds: currentTileIds, failed, diagnostics: collectDiagnostics() }, group.id, index);
      throw new Error("Flow generation failed.");
    }

    const completedWithoutUrl = preferVideo ? completedStatuses : [];
    if (completedWithoutUrl.length >= payload.outputCount) {
      if (!loggedCompletedVideoWithoutUrl) {
        loggedCompletedVideoWithoutUrl = true;
        completedVideoWithoutUrlAt = Date.now();
        log("warn", "Flow video card completed but direct media URL was not exposed yet", { tileIds: currentTileIds, completedWithoutUrl }, group.id, index);
      }
      if (networkVideoUrls.length >= payload.outputCount) {
        log("info", "Using prompt-matched Flow video URL from generation response", {
          tileIds: currentTileIds,
          resources: networkVideoUrls.length
        }, group.id, index);
        return waitForDownloadReadiness(currentTileIds, networkVideoUrls, staleResourceUrls, payload, group, index, statuses);
      }
      const cardDownloadResources = completedVideoCardDownloadResources(
        completedWithoutUrl,
        payload,
        group,
        index
      );
      if (cardDownloadResources.length >= payload.outputCount) {
        log("info", "Using Flow card download action", {
          tileIds: currentTileIds,
          resources: cardDownloadResources.length
        }, group.id, index);
        return cardDownloadResources;
      }
      const waitedMs = Date.now() - completedVideoWithoutUrlAt;
      updateResult(group, index, {
        percentage: 95,
        error: "Video is ready in Flow; waiting for a downloadable video URL."
      });
      if (waitedMs >= videoCompletedWithoutUrlGraceMs) {
        log("warn", "Flow video card completed but no downloadable media URL appeared", {
          tileIds: currentTileIds,
          completedWithoutUrl,
          waitedSeconds: Math.round(waitedMs / 1000)
        }, group.id, index);
        throw new Error("Flow video is visible, but the downloadable video URL did not appear. Retrying.");
      }
      await sleep(5000);
      continue;
    }

    const bestProgress = Math.max(0, ...statuses.map((status) => status.progress ?? 0));
    const progress = bestProgress > 0
      ? Math.max(25, Math.min(94, bestProgress))
      : Math.max(25, Math.min(90, Math.round((found.length / Math.max(1, payload.outputCount)) * 90)));
    updateResult(group, index, { percentage: progress });
    await sleep(preferVideo ? 5000 : 1200);
  }

  log("warn", "Flow output did not finish before timeout", {
    tileIds: [...trackedTileIds],
    staleResourceUrlsIgnored: staleResourceUrls.size,
    diagnostics: collectDiagnostics()
  }, group.id, index);
  throw new Error("Flow output did not finish before timeout.");
}

function promptRunKey(group: RunningGroup, index: number, payload: PromptPayload) {
  return `${group.id}:${index}:${payload.id}`;
}

function tileOwnerAllows(group: RunningGroup, tileId: string, index: number) {
  const owner = group.tileOwners.get(tileId);
  const status = describeTileStatus(tileId);
  if (owner !== undefined) {
    if (owner === index) return true;
    const ownerStillMatches = tileStatusMatchesPromptIndex(group, owner, status);
    const currentMatches = tileStatusMatchesPromptIndex(group, index, status);
    if (currentMatches && !ownerStillMatches) {
      group.tileOwners.delete(tileId);
      return setTileOwner(group, index, tileId, "prompt-match");
    }
    return false;
  }
  const promptOwner = tilePromptOwner(group, tileId);
  if (promptOwner !== undefined) {
    setTileOwner(group, promptOwner, tileId, "prompt-match");
    return promptOwner === index;
  }
  const tile = tileElementForId(tileId);
  const elementOwner = tile ? generatedCardOwners.get(tile) : undefined;
  if (elementOwner !== undefined) {
    const ownerStillMatches = tileStatusMatchesPromptIndex(group, elementOwner, status);
    const currentMatches = tileStatusMatchesPromptIndex(group, index, status);
    if (currentMatches && !ownerStillMatches) {
      return setTileOwner(group, index, tileId, "prompt-match");
    }
    if (elementOwner === index) setTileOwner(group, index, tileId, "generic");
    return elementOwner === index;
  }
  return true;
}

function tileStatusMatchesPromptIndex(group: RunningGroup, index: number, status: TileStatus | null) {
  const payload = group.payloads[index];
  return Boolean(payload && status && tileTextLooksRelatedToPrompt(status.text, payload.prompt));
}

function claimTileIds(
  group: RunningGroup,
  index: number,
  tileIds: string[],
  reason: TileOwnerReason | ((tileId: string) => TileOwnerReason) = "generic"
) {
  for (const tileId of tileIds) {
    setTileOwner(group, index, tileId, typeof reason === "function" ? reason(tileId) : reason);
  }
}

function setTileOwner(group: RunningGroup, index: number, tileId: string, reason: TileOwnerReason) {
  const owner = group.tileOwners.get(tileId);
  if (owner !== undefined && owner !== index) return false;
  group.tileOwners.set(tileId, index);
  const existingClaim = group.tileOwnerClaims.get(tileId);
  if (!existingClaim || existingClaim.index !== index || tileOwnerReasonRank(reason) > tileOwnerReasonRank(existingClaim.reason)) {
    group.tileOwnerClaims.set(tileId, { index, reason });
  }
  const tile = tileElementForId(tileId);
  if (tile) {
    generatedCardOwners.set(tile, index);
    const rect = snapshotTileRect(tileId);
    if (rect) group.tileOwnerRects.set(tileId, rect);
  }
  return true;
}

function tileOwnerReasonRank(reason: TileOwnerReason) {
  if (reason === "prompt-match") return 3;
  if (reason === "exclusive-new-card" || reason === "timed-generated-card") return 2;
  return 1;
}

function rememberTileCandidates(group: RunningGroup, index: number, tileIds: string[]) {
  if (tileIds.length === 0) return;
  const remembered = group.tileCandidateMemory.get(index) ?? [];
  for (const tileId of tileIds) {
    const rect = snapshotTileRect(tileId);
    const existing = remembered.find((candidate) => candidate.tileId === tileId);
    if (existing) {
      if (rect) existing.rect = rect;
      continue;
    }
    remembered.push({ tileId, rect });
  }
  group.tileCandidateMemory.set(index, remembered);
}

function rememberObservedTileIds(group: RunningGroup, tileIds: string[], seenAt = Date.now()) {
  for (const tileId of tileIds) {
    if (!group.tileFirstSeenAt.has(tileId)) group.tileFirstSeenAt.set(tileId, seenAt);
  }
  return tileIds;
}

function rememberedTileCandidates(group: RunningGroup, index: number) {
  const remembered = group.tileCandidateMemory.get(index) ?? [];
  const visibleTileIds = collectTileIds();
  return unique(remembered.flatMap((candidate) => {
    if (visibleTileIds.includes(candidate.tileId)) return [candidate.tileId];
    const rememberedRect = candidate.rect;
    if (!rememberedRect) return [];
    const replacementId = visibleTileIds.find((tileId) => {
      if (!tileOwnerAllows(group, tileId, index)) return false;
      const rect = snapshotTileRect(tileId);
      return Boolean(rect && rectsRepresentSameTile(rect, rememberedRect));
    });
    return replacementId ? [replacementId] : [];
  }));
}

function registerTileWaiter(group: RunningGroup, index: number) {
  if (!group.tileWaitOrder.includes(index)) group.tileWaitOrder.push(index);
}

function releaseTileWaiter(group: RunningGroup, index: number) {
  group.tileWaitOrder = group.tileWaitOrder.filter((item) => item !== index);
  group.tileCandidateMemory.delete(index);
}

function tileWaiterCanClaimGeneric(group: RunningGroup, index: number) {
  return group.tileWaitOrder[0] === index;
}

function canClaimExclusiveNewCard(group: RunningGroup, index: number, payload: PromptPayload, tileId?: string) {
  if (payload.mode.includes("video")) return false;
  if (!tileWaiterCanClaimGeneric(group, index)) return false;
  const submittedAt = group.submittedAtByIndex.get(index) ?? 0;
  const firstSeenAt = tileId ? group.tileFirstSeenAt.get(tileId) ?? Date.now() : Date.now();
  if (submittedAt && firstSeenAt < submittedAt - 500) return false;
  return ![...group.submittedAtByIndex].some(([submittedIndex, newerSubmittedAt]) => (
    submittedIndex > index && newerSubmittedAt <= firstSeenAt + 500
  ));
}

function shouldRunTimedImageProbe(payload: PromptPayload, group: RunningGroup, index: number, startedAt: number) {
  return (
    !payload.mode.includes("video") &&
    tileWaiterCanClaimGeneric(group, index) &&
    Date.now() - startedAt >= imageTileStuckProbeMs
  );
}

function timedImageProbeCandidates(
  group: RunningGroup,
  index: number,
  knownBefore: string[],
  payload: PromptPayload,
  observedTileIds: string[],
  staleResourceUrls: Set<string>,
  options: { requireComplete: boolean; requireDownloadableUrl: boolean }
) {
  const submittedAt = group.submittedAtByIndex.get(index) ?? 0;
  return observedTileIds
    .filter((tileId) => !knownBefore.includes(tileId) && tileOwnerAllows(group, tileId, index))
    .filter((tileId) => {
      const firstSeenAt = group.tileFirstSeenAt.get(tileId) ?? Date.now();
      if (submittedAt && firstSeenAt < submittedAt - 500) return false;
      const status = describeTileStatus(tileId);
      if (!status || status.failed || !status.visible || !status.imageOnly) return false;
      const promptOwner = tilePromptOwner(group, tileId);
      if (promptOwner !== undefined && promptOwner !== index) return false;
      if (options.requireComplete && !isTileComplete(status)) return false;
      if (!options.requireComplete && !(isTileComplete(status) || isTileStillGenerating(status))) return false;
      if (!options.requireDownloadableUrl) return true;
      return resourceUrlsForTile(tileId, false).some((url) => !staleResourceUrls.has(url));
    })
    .sort((a, b) => timedImageProbeSortScore(group, b, payload) - timedImageProbeSortScore(group, a, payload));
}

function timedImageProbeStatuses(
  group: RunningGroup,
  index: number,
  knownBefore: string[],
  payload: PromptPayload,
  observedTileIds: string[]
) {
  return observedTileIds
    .filter((tileId) => !knownBefore.includes(tileId) && tileOwnerAllows(group, tileId, index))
    .map((tileId) => describeTileStatus(tileId))
    .filter((status): status is TileStatus => Boolean(status))
    .filter((status) => !payload.mode.includes("video") || !status.imageOnly || status.videoLike);
}

function timedImageProbeSortScore(group: RunningGroup, tileId: string, payload: PromptPayload) {
  const status = describeTileStatus(tileId);
  const promptMatchBonus = status && tileTextLooksRelatedToPrompt(status.text, payload.prompt) ? 1_000_000_000 : 0;
  const firstSeenAt = group.tileFirstSeenAt.get(tileId) ?? Date.now();
  return promptMatchBonus - firstSeenAt;
}

function tileClaimReasonForWaitSelection(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  tileId: string
): TileOwnerReason {
  const status = describeTileStatus(tileId);
  if (status && tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return "prompt-match";
  return canClaimExclusiveNewCard(group, index, payload, tileId) ? "exclusive-new-card" : "generic";
}

function relatedTileClaimReason(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  tileId: string,
  knownTileIds: string[]
): TileOwnerReason {
  const status = describeTileStatus(tileId);
  if (status && tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return "prompt-match";
  return strongestRelatedOwnerReason(group, index, tileId, knownTileIds) ?? tileClaimReasonForWaitSelection(group, index, payload, tileId);
}

function strongestRelatedOwnerReason(
  group: RunningGroup,
  index: number,
  tileId: string,
  knownTileIds: string[]
): TileOwnerReason | undefined {
  const rect = snapshotTileRect(tileId);
  if (!rect) return undefined;
  let best: TileOwnerReason | undefined;
  for (const knownTileId of knownTileIds) {
    const claim = group.tileOwnerClaims.get(knownTileId);
    const knownRect = group.tileOwnerRects.get(knownTileId) ?? snapshotTileRect(knownTileId);
    if (!claim || claim.index !== index || !knownRect || !rectsRepresentSameTile(rect, knownRect)) continue;
    if (!best || tileOwnerReasonRank(claim.reason) > tileOwnerReasonRank(best)) best = claim.reason;
  }
  return best;
}

function isTileComplete(status: TileStatus) {
  const hasCompletedControls = tileStatusHasCompletedControls(status);
  if (status.failed || status.generating) return false;
  if (!status.playable && !(status.imageOnly && hasCompletedControls)) return false;
  if (isLabelGeneratedCardId(status.tileId) && !hasCompletedControls) return false;
  return status.progress === undefined || status.progress >= 99;
}

function isTileStillGenerating(status: TileStatus) {
  return !status.failed && (status.generating || (status.progress !== undefined && status.progress < 99));
}

function tilePromptOwner(group: RunningGroup, tileId: string) {
  const status = describeTileStatus(tileId);
  if (!status) return undefined;
  const activeMatches = [...group.runningIndexes]
    .filter((promptIndex) => tileTextLooksRelatedToPrompt(status.text, group.payloads[promptIndex]?.prompt ?? ""));
  if (activeMatches.length === 1) return activeMatches[0];

  const claimedMatches = unique([...group.tileOwners.values()].map(String))
    .map((value) => Number(value))
    .filter((promptIndex) => Number.isInteger(promptIndex) && tileTextLooksRelatedToPrompt(status.text, group.payloads[promptIndex]?.prompt ?? ""));
  return claimedMatches.length === 1 ? claimedMatches[0] : undefined;
}

function isLabelGeneratedCardId(tileId: string) {
  return tileId.startsWith("flow-card-label-");
}

function tileStatusHasCompletedControls(status: TileStatus) {
  return /favorite|favourite|reuse prompt|download|download_for_offline|more_vert|more options/i.test(status.text);
}

function canUseStatusForVideoDownload(status: TileStatus) {
  return status.visible && status.videoLike && !status.imageOnly;
}

function videoContextLabelsForStatuses(statuses: TileStatus[]) {
  return unique(statuses
    .map((status) => videoContextLabelForStatus(status))
    .filter((label): label is string => Boolean(label)));
}

function videoContextLabelForStatus(status: TileStatus) {
  const cleaned = normalizePromptSearchText(status.text)
    .replace(/\b(?:play circle|360p|480p|720p|1080p|favorite|favourite|redo|more vert|keyboard return|download|warning|failed|sorry|this|video|generate|charged|generation|refresh|undo|delete forever)\b/g, " ")
    .replace(/\b\d{1,3}\s*%/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const promptStart = cleaned.search(/\bwarm semi flat 2d digital\b|\bwide cinematic\b|\bnight inside\b|\bextreme close up\b/);
  const title = (promptStart > 0 ? cleaned.slice(0, promptStart) : cleaned).trim();
  return title.split(" ").slice(0, 8).join(" ");
}

function collectRelatedTileIds(group: RunningGroup, index: number, payload: PromptPayload, knownTileIds: string[]) {
  const submittedAt = group.submittedAtByIndex.get(index) ?? 0;
  const knownRects = knownTileIds
    .map((tileId) => {
      const liveRect = tileElementForId(tileId)?.getBoundingClientRect();
      return liveRect ?? group.tileOwnerRects.get(tileId) ?? null;
    })
    .filter(Boolean) as DOMRect[];
  return collectTileIds().filter((tileId) => {
    if (knownTileIds.includes(tileId)) return false;
    const firstSeenAt = group.tileFirstSeenAt.get(tileId) ?? Date.now();
    if (submittedAt && firstSeenAt < submittedAt - 500) return false;
    const status = describeTileStatus(tileId);
    if (!status) return false;
    if (payload.mode.includes("video") && status.imageOnly && !status.videoLike) return false;
    if (payload.mode.includes("video") && resourceWasAlreadyDownloaded(flowCardDownloadResource(status.tileId), group)) return false;
    const tile = tileElementForId(tileId);
    const rect = tile?.getBoundingClientRect();
    const matchesKnownTile = Boolean(rect && knownRects.some((knownRect) => rectsRepresentSameTile(rect, knownRect)));
    const matchesPrompt = tileTextLooksRelatedToPrompt(status.text, payload.prompt);
    if (matchesPrompt) {
      if (!payload.mode.includes("video")) {
        return matchesKnownTile || status.generating || status.playable || ((status.progress ?? 0) > 0 && !status.failed);
      }
      if (matchesKnownTile || tilePromptOwner(group, tileId) === index) return true;
      return status.generating || ((status.progress ?? 0) > 0 && !isTileComplete(status));
    }
    return matchesKnownTile && (
      status.generating ||
      status.playable ||
      isTileComplete(status) ||
      (status.progress !== undefined && status.progress < 99)
    );
  });
}

function refreshedPromptTileIds(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  baseTileIds: string[],
  options: { knownBefore?: string[]; preferDownloadableImages?: boolean } = {}
) {
  const observedTileIds = rememberObservedTileIds(group, collectTileIds());
  const knownBefore = new Set(options.knownBefore ?? []);
  const candidates = unique([
    ...baseTileIds,
    ...rememberedTileCandidates(group, index),
    ...collectRelatedTileIds(group, index, payload, baseTileIds),
    ...observedTileIds.filter((tileId) => observedTileCanRefreshPromptTile(group, index, payload, tileId))
  ]);
  return candidates
    .filter((tileId) => baseTileIds.includes(tileId) || !knownBefore.has(tileId))
    .filter((tileId) => tileCanRepresentRequestedOutput(tileId, payload))
    .filter((tileId) => tileOwnerAllows(group, tileId, index))
    .filter((tileId) => refreshedTileBelongsToPrompt(group, index, payload, tileId, baseTileIds))
    .sort((a, b) => refreshedPromptTileScore(group, index, payload, b, baseTileIds, options) -
      refreshedPromptTileScore(group, index, payload, a, baseTileIds, options));
}

function observedTileCanRefreshPromptTile(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  tileId: string
) {
  if (!tileOwnerAllows(group, tileId, index)) return false;
  const status = describeTileStatus(tileId);
  return Boolean(status && !status.failed && tileTextLooksRelatedToPrompt(status.text, payload.prompt));
}

function refreshedTileBelongsToPrompt(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  tileId: string,
  baseTileIds: string[]
) {
  if (baseTileIds.includes(tileId)) return true;
  const status = describeTileStatus(tileId);
  if (status && tileTextLooksRelatedToPrompt(status.text, payload.prompt)) {
    if (!payload.mode.includes("video")) return true;
    if (tilePromptOwner(group, tileId) === index) return true;
    return Boolean(strongestRelatedOwnerReason(group, index, tileId, baseTileIds));
  }
  const claim = group.tileOwnerClaims.get(tileId);
  if (claim?.index === index && tileOwnerReasonRank(claim.reason) >= tileOwnerReasonRank("exclusive-new-card")) return true;
  return Boolean(strongestRelatedOwnerReason(group, index, tileId, baseTileIds));
}

function refreshedPromptTileScore(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  tileId: string,
  baseTileIds: string[],
  options: { preferDownloadableImages?: boolean }
) {
  const status = describeTileStatus(tileId);
  const hasDownloadableImageUrl = options.preferDownloadableImages && resourceUrlsForTile(tileId, false).length > 0;
  const promptMatch = status && tileTextLooksRelatedToPrompt(status.text, payload.prompt);
  const complete = status && isTileComplete(status);
  const claim = group.tileOwnerClaims.get(tileId);
  const claimRank = claim?.index === index ? tileOwnerReasonRank(claim.reason) : 0;
  return (
    (hasDownloadableImageUrl ? 1_000_000_000 : 0) +
    (promptMatch ? 100_000_000 : 0) +
    (complete ? 10_000_000 : 0) +
    claimRank * 100_000 +
    (baseTileIds.includes(tileId) ? 10_000 : 0) +
    visualAgeScore(tileId)
  );
}

function tileLooksLikeNewPromptResult(tileId: string, payload: PromptPayload) {
  const status = describeTileStatus(tileId);
  if (!status) return false;
  if (status.failed) return false;
  if (payload.mode.includes("video") && status.imageOnly && !status.videoLike) return false;
  if (tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return true;
  if (isTileComplete(status)) return false;
  return status.generating || (status.progress !== undefined && status.progress < 99);
}

function tileLooksGenericClaimable(tileId: string) {
  const status = describeTileStatus(tileId);
  if (!status || status.failed) return false;
  return status.generating || (status.progress !== undefined && status.progress < 99);
}

function tileLooksRememberedClaimable(tileId: string, payload: PromptPayload) {
  const status = describeTileStatus(tileId);
  if (!status || status.failed) return false;
  if (payload.mode.includes("video") && status.imageOnly && !status.videoLike) return false;
  if (tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return true;
  return status.generating || (status.progress !== undefined && status.progress < 99);
}

function completedTileFallbackCandidates(group: RunningGroup, index: number, knownBefore: string[], payload: PromptPayload) {
  return collectTileIds()
    .filter((tileId) => !knownBefore.includes(tileId) && tileOwnerAllows(group, tileId, index))
    .filter((tileId) => tileCanRepresentRequestedOutput(tileId, payload))
    .filter((tileId) => completedTileFallbackAllowed(group, index, tileId, payload))
    .filter(tileLooksCompletedClaimable)
    .sort((a, b) => visualAgeScore(b) - visualAgeScore(a));
}

function completedTileFallbackAllowed(group: RunningGroup, index: number, tileId: string, payload: PromptPayload) {
  const status = describeTileStatus(tileId);
  if (!status) return false;
  if (tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return true;
  if (tilePromptOwner(group, tileId) === index) return true;
  if (payload.mode.includes("video")) return false;
  if (group.runningIndexes.size <= 1) return true;
  return canClaimExclusiveNewCard(group, index, payload, tileId) && status.visible && status.imageOnly;
}

function tileCanRepresentRequestedOutput(tileId: string, payload: PromptPayload) {
  if (!payload.mode.includes("video")) return true;
  const status = describeTileStatus(tileId);
  return Boolean(status && canUseStatusForVideoDownload(status));
}

function tileLooksCompletedClaimable(tileId: string) {
  const status = describeTileStatus(tileId);
  return Boolean(status && isTileComplete(status));
}

function visualAgeScore(tileId: string) {
  const rect = snapshotTileRect(tileId);
  if (!rect) return 0;
  return Math.round(rect.top) * 10000 + Math.round(rect.left);
}

function snapshotTileRect(tileId: string): RectSnapshot | null {
  const rect = tileElementForId(tileId)?.getBoundingClientRect();
  if (!rect) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

async function waitForDownloadReadiness(
  tileIds: string[],
  resources: string[],
  staleResourceUrls: Set<string>,
  payload: PromptPayload,
  group: RunningGroup,
  index: number,
  statuses: TileStatus[]
) {
  const activeWorkers = group.runningIndexes.size;
  const generatingTiles = countActiveGenerationTiles();
  if (activeWorkers <= 1 || generatingTiles === 0 || (group.concurrentPrompts < 3 && generatingTiles <= payload.outputCount)) {
    return preferExactTileDownload(tileIds, resources, staleResourceUrls, payload, group, index, statuses);
  }

  const preferVideo = payload.mode.includes("video");
  const baseDelayMs = preferVideo ? highConcurrencyVideoDownloadDelayMs : highConcurrencyImageDownloadDelayMs;
  const pressureDelayMs = Math.max(0, activeWorkers - 1) * 4000 + Math.max(0, generatingTiles - payload.outputCount) * 1500;
  const delayMs = Math.min(maxHighConcurrencyDownloadDelayMs, Math.max(baseDelayMs, pressureDelayMs));
  log("info", "Waiting before download while other Flow generations settle", {
    delaySeconds: Math.round(delayMs / 1000),
    activeWorkers,
    generatingTiles,
    tileIds,
    statuses
  }, group.id, index);

  const end = Date.now() + delayMs;
  while (!group.isCancelling && Date.now() < end) {
    updateResult(group, index, {
      percentage: 95,
      error: "Waiting a few seconds before download because multiple generations are still active."
    });
    await sleep(500);
  }
  if (group.isCancelling) throw new Error("Cancelled");

  const refreshed = unique(tileIds.flatMap((tileId) => resourceUrlsForTile(tileId, preferVideo)))
    .filter((url) => !staleResourceUrls.has(url));
  const finalResources = refreshed.length >= payload.outputCount ? refreshed : resources;
  updateResult(group, index, { error: undefined });
  return preferExactTileDownload(tileIds, finalResources, staleResourceUrls, payload, group, index, statuses);
}

function preferExactTileDownload(
  tileIds: string[],
  resources: string[],
  staleResourceUrls: Set<string>,
  payload: PromptPayload,
  group: RunningGroup,
  index: number,
  statuses: TileStatus[]
) {
  const preferVideo = payload.mode.includes("video");
  if (!preferVideo) {
    const directImageFallbackResources = directImageFallbackResourceUrls(
      tileIds,
      resources,
      staleResourceUrls,
      payload,
      group,
      index,
      statuses
    );
    if (directImageFallbackResources.length < payload.outputCount) {
      log("warn", "No matching direct image URL was available", {
        tileIds,
        staleResourceUrlsIgnored: staleResourceUrls.size,
        resources: resources.length,
        statuses,
        activeWorkers: group.runningIndexes.size
      }, group.id, index);
      throw new Error("Flow image is ready, but a matching downloadable image URL was not available. Retrying.");
    }
    log("info", "Using direct image URL from matched Flow card", {
      tileIds,
      staleResourceUrlsIgnored: staleResourceUrls.size,
      resources: directImageFallbackResources.length,
      statuses
    }, group.id, index);
    return directImageFallbackResources.slice(0, payload.outputCount);
  }
  return resources.slice(0, payload.outputCount);
}

function directImageFallbackResourceUrls(
  tileIds: string[],
  resources: string[],
  staleResourceUrls: Set<string>,
  payload: PromptPayload,
  group: RunningGroup,
  index: number,
  statuses: TileStatus[]
) {
  if (resources.length < payload.outputCount) return [];
  const availableResourceUrls = new Set(resources.filter((url) => !staleResourceUrls.has(url)));
  if (availableResourceUrls.size < payload.outputCount) return [];
  const statusByTileId = new Map(statuses.map((status) => [status.tileId, status]));
  const matchingTileIds = tileIds.filter((tileId) => {
    const status = statusByTileId.get(tileId) ?? describeTileStatus(tileId);
    if (!status || !isTileComplete(status)) return false;
    const owner = tilePromptOwner(group, tileId);
    if (owner !== undefined && owner !== index) return false;
    if (tileTextLooksRelatedToPrompt(status.text, payload.prompt)) return true;
    const claim = group.tileOwnerClaims.get(tileId);
    return claim?.index === index && (
      claim.reason === "prompt-match" ||
      claim.reason === "exclusive-new-card" ||
      claim.reason === "timed-generated-card"
    );
  });
  return unique(matchingTileIds.flatMap((tileId) => resourceUrlsForTile(tileId, false)))
    .filter((url) => availableResourceUrls.has(url));
}

function flowCardDownloadResource(tileId: string) {
  return `${flowCardDownloadResourcePrefix}${encodeURIComponent(tileId)}`;
}

function isFlowCardDownloadResource(resource: string) {
  return resource.startsWith(flowCardDownloadResourcePrefix);
}

function decodeFlowCardDownloadResource(resource: string) {
  return decodeURIComponent(resource.slice(flowCardDownloadResourcePrefix.length));
}

function countActiveGenerationTiles() {
  return collectTileIds()
    .map((tileId) => describeTileStatus(tileId))
    .filter((status): status is TileStatus => Boolean(status))
    .filter((status) => !status.failed && (status.generating || ((status.progress ?? 0) > 0 && !isTileComplete(status))))
    .length;
}

function finalUnclaimedVideoCardStatuses(group: RunningGroup, index: number, payload: PromptPayload) {
  if (group.runningIndexes.size > 1) return [];
  return collectTileIds()
    .filter((tileId) => {
      const owner = group.tileOwners.get(tileId);
      return owner === undefined || owner === index;
    })
    .map((tileId) => describeTileStatus(tileId))
    .filter((status): status is TileStatus => Boolean(status))
    .filter((status) => {
      if (!isTileComplete(status) || !canUseStatusForVideoDownload(status)) return false;
      return videoStatusBelongsToCurrentTurn(status, group, index);
    })
    .sort((a, b) => videoCardDownloadScore(b, payload, group, index) -
      videoCardDownloadScore(a, payload, group, index));
}

function uniqueStatusByTileId(status: TileStatus, index: number, statuses: TileStatus[]) {
  return statuses.findIndex((candidate) => candidate.tileId === status.tileId) === index;
}

function completedVideoCardDownloadResources(
  statuses: TileStatus[],
  payload: PromptPayload,
  group: RunningGroup,
  index: number
) {
  const availableStatuses = statuses
    .filter((status) => videoStatusBelongsToCurrentTurn(status, group, index));
  const rankedStatuses = availableStatuses
    .sort((a, b) => videoCardDownloadScore(b, payload, group, index) -
      videoCardDownloadScore(a, payload, group, index));
  const selectedStatuses = rankedStatuses
    .slice(0, Math.max(payload.outputCount, Math.min(3, rankedStatuses.length)));
  return selectedStatuses.map((status) => flowCardDownloadResource(status.tileId));
}

function videoStatusBelongsToCurrentTurn(status: TileStatus, group: RunningGroup, index: number) {
  if (group.knownBeforeTileIdsByIndex.get(index)?.has(status.tileId)) return false;
  if (resourceWasAlreadyDownloaded(flowCardDownloadResource(status.tileId), group)) return false;
  const owner = tilePromptOwner(group, status.tileId);
  if (owner !== undefined && owner !== index) return false;
  const submittedAt = group.submittedAtByIndex.get(index) ?? 0;
  const firstSeenAt = group.tileFirstSeenAt.get(status.tileId) ?? Date.now();
  if (submittedAt && firstSeenAt < submittedAt - 1000) return false;
  return true;
}

function videoCardDownloadScore(status: TileStatus, payload: PromptPayload, group: RunningGroup, index: number) {
  const promptMatch = tileTextLooksRelatedToPrompt(status.text, payload.prompt);
  const claim = group.tileOwnerClaims.get(status.tileId);
  const claimRank = claim?.index === index ? tileOwnerReasonRank(claim.reason) : 0;
  const ownerBonus = group.tileOwners.get(status.tileId) === index ? 1 : 0;
  return (
    (promptMatch ? 1_000_000_000 : 0) +
    claimRank * 1_000_000 +
    ownerBonus * 100_000 +
    visualAgeScore(status.tileId)
  );
}

function rectsRepresentSameTile(rect: RectSnapshot, knownRect: RectSnapshot) {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const knownCenterX = knownRect.left + knownRect.width / 2;
  const knownCenterY = knownRect.top + knownRect.height / 2;
  const closeCenters = Math.abs(centerX - knownCenterX) <= 90 && Math.abs(centerY - knownCenterY) <= 90;
  const similarSize =
    Math.abs(rect.width - knownRect.width) <= Math.max(80, knownRect.width * 0.35) &&
    Math.abs(rect.height - knownRect.height) <= Math.max(80, knownRect.height * 0.35);
  if (closeCenters && similarSize) return true;

  const overlapWidth = Math.max(0, Math.min(rect.left + rect.width, knownRect.left + knownRect.width) - Math.max(rect.left, knownRect.left));
  const overlapHeight = Math.max(0, Math.min(rect.top + rect.height, knownRect.top + knownRect.height) - Math.max(rect.top, knownRect.top));
  const overlapArea = overlapWidth * overlapHeight;
  const smallerArea = Math.max(1, Math.min(rect.width * rect.height, knownRect.width * knownRect.height));
  if (overlapArea / smallerArea >= 0.6) return true;

  const rectCenterInKnown = pointInsideExpandedRect(centerX, centerY, knownRect, 36);
  const knownCenterInRect = pointInsideExpandedRect(knownCenterX, knownCenterY, rect, 36);
  const horizontalOverlapRatio = overlapWidth / Math.max(1, Math.min(rect.width, knownRect.width));
  return (rectCenterInKnown || knownCenterInRect) && horizontalOverlapRatio >= 0.5;
}

function pointInsideExpandedRect(x: number, y: number, rect: RectSnapshot, padding: number) {
  return x >= rect.left - padding &&
    x <= rect.left + rect.width + padding &&
    y >= rect.top - padding &&
    y <= rect.top + rect.height + padding;
}

async function downloadResources(resources: string[], payload: PromptPayload, group: RunningGroup, index: number) {
  const quality = payload.mode.includes("video") ? payload.autoDownloadResourceQuality : payload.autoDownloadResourceQuality;
  if (quality === "no-download" || resources.length === 0) return 0;

  await sendRuntimeMessage({
    type: "SET_DOWNLOAD_NAMING",
    folderName: payload.folderName,
    filePrefix: payload.filePrefix,
    autoChangeFileName: payload.autoChangeFileName
  });

  let downloaded = 0;
  for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex += 1) {
    const url = resources[resourceIndex];
    if (payload.mode.includes("video") && resourceWasAlreadyDownloaded(url, group)) {
      log("info", "Skipping already downloaded video resource", {
        resourceIndex: resourceIndex + 1,
        totalResources: resources.length
      }, group.id, index);
      continue;
    }
    const filename = outputFilename(payload, index, downloaded, payload.outputCount);
    log("debug", "Starting Chrome download", { filename, resourceIndex: resourceIndex + 1, totalResources: resources.length }, group.id, index);
    const result = isFlowCardDownloadResource(url)
      ? await downloadFlowCardResource(url, filename, payload, group, index)
      : /^blob:/i.test(url)
      ? await downloadPageResourceUrl(url, filename, payload)
      : await sendRuntimeMessage<{ downloadId: number; state?: string }>({
        type: "START_DOWNLOAD",
        url,
        filename,
        folder: payload.folderName,
        filePrefix: payload.filePrefix,
        autoChangeFileName: payload.autoChangeFileName
      });
    if (result.success) {
      downloaded += 1;
      rememberDownloadedResource(url, group);
      log("info", "Chrome download completed", { filename, downloadId: result.downloadId, state: result.state ?? "complete" }, group.id, index);
      if (downloaded >= payload.outputCount) break;
    } else {
      log("warn", "Chrome download failed", { filename, error: result.error }, group.id, index);
      if (isFlowCardDownloadResource(url) && resourceIndex < resources.length - 1) continue;
      throw new Error(result.error || "Chrome download failed.");
    }
  }
  if (payload.mode.includes("video") && downloaded < payload.outputCount) {
    throw new Error("Flow returned a video that was already downloaded. Retrying for a new video.");
  }
  return downloaded;
}

function resourceWasAlreadyDownloaded(resource: string, group: RunningGroup) {
  return group.downloadedResourceKeys.has(downloadedResourceKey(resource));
}

function rememberDownloadedResource(resource: string, group: RunningGroup) {
  group.downloadedResourceKeys.add(downloadedResourceKey(resource));
}

function downloadedResourceKey(resource: string) {
  if (isFlowCardDownloadResource(resource)) return `flow-card:${decodeFlowCardDownloadResource(resource)}`;
  return resource;
}

async function downloadFlowCardResource(
  resource: string,
  filename: string,
  payload: PromptPayload,
  group: RunningGroup,
  index: number
): Promise<RuntimeResponse<{ downloadId: number; state?: string }>> {
  const tileId = decodeFlowCardDownloadResource(resource);
  const expectationId = `flow-card-download-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const registered = await sendRuntimeMessage({
    type: "REGISTER_EXPECTED_FLOW_DOWNLOAD",
    expectationId,
    filename,
    folder: payload.folderName,
    filePrefix: payload.filePrefix,
    autoChangeFileName: payload.autoChangeFileName
  });
  if (!registered.success) return { success: false, error: registered.error };

  try {
    const clicked = await triggerFlowCardDownload(tileId, group, index);
    if (!clicked) return { success: false, error: "Could not find the Flow card download action." };
    return await sendRuntimeMessage<{ downloadId: number; state?: string }>({
      type: "WAIT_EXPECTED_FLOW_DOWNLOAD",
      expectationId,
      timeoutMs: 12 * 60 * 1000
    });
  } finally {
    await sendKey("Escape", "Escape", 27).catch(() => undefined);
    await sendRuntimeMessage({ type: "CLEAR_EXPECTED_FLOW_DOWNLOAD", expectationId }).catch(() => undefined);
  }
}

async function triggerFlowCardDownload(tileId: string, group: RunningGroup, index: number) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tile = tileElementForId(tileId);
    if (!tile) {
      log("warn", "Flow card download action could not find tile", { tileId, attempt }, group.id, index);
      return false;
    }

    tile.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    tile.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    tile.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await sleep(attempt === 1 ? 300 : 700);

    const directDownload = findCardDownloadControl(tile);
    if (directDownload) {
      log("debug", "Clicking Flow card download control", { tileId, attempt, button: describeElement(directDownload) }, group.id, index);
      await clickElement(directDownload);
      return true;
    }

    const moreButton = findCardMoreOptionsControl(tile);
    if (!moreButton) {
      log("warn", "Flow card download action could not find More options", {
        tileId,
        attempt,
        controls: describeVisibleControls(tile)
      }, group.id, index);
      await sendKey("Escape", "Escape", 27).catch(() => undefined);
      continue;
    }

    log("debug", "Opening Flow card menu for download", { tileId, attempt, button: describeElement(moreButton) }, group.id, index);
    await clickElement(moreButton);
    await sleep(900);

    const menuDownload = findFlowDownloadMenuOption();
    if (!menuDownload) {
      log("warn", "Flow card menu did not expose a download action", {
        tileId,
        attempt,
        menuControls: describeVisibleMenuControls()
      }, group.id, index);
      await sendKey("Escape", "Escape", 27).catch(() => undefined);
      await sleep(250);
      continue;
    }

    log("debug", "Clicking Flow card menu download action", { tileId, attempt, button: describeElement(menuDownload) }, group.id, index);
    await clickElement(menuDownload);
    await sleep(800);

    const qualityOption = findFlowDownloadQualityOption();
    if (qualityOption) {
      log("debug", "Clicking Flow card download quality", { tileId, attempt, button: describeElement(qualityOption) }, group.id, index);
      await clickElement(qualityOption);
      return true;
    }

    if (flowMenuDownloadOptionLooksDirect(menuDownload)) return true;

    log("warn", "Flow card download submenu did not expose an enabled video quality", {
      tileId,
      attempt,
      menuControls: describeVisibleMenuControls()
    }, group.id, index);
    await sendKey("Escape", "Escape", 27).catch(() => undefined);
    await sleep(250);
  }
  return false;
}

function findCardDownloadControl(tile: HTMLElement) {
  return cardControls(tile)
    .filter((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return /download|download_for_offline|save/i.test(label) && !/upload|downloaded|downloads folder/.test(label);
    })
    .sort((a, b) => controlPriorityScore(b) - controlPriorityScore(a))[0] ?? null;
}

function findCardMoreOptionsControl(tile: HTMLElement) {
  return cardControls(tile)
    .filter((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return /more options|more_vert|more/.test(label) && !/learn more/.test(label);
    })
    .sort((a, b) => controlPriorityScore(b) - controlPriorityScore(a))[0] ?? null;
}

function cardControls(tile: HTMLElement) {
  return uniqueElements(deepQueryAll<HTMLElement>("button, [role='button'], a", tile)
    .filter((element) => isVisible(element) && !isDisabled(element)));
}

function findFlowDownloadMenuOption() {
  return uniqueElements(safeQueryAll("button, [role='button'], [role='menuitem'], a"))
    .filter((element) => isVisible(element) && !isDisabled(element))
    .filter((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return /download|download_for_offline|save video|export/.test(label) && !/upload|downloaded|downloads folder/.test(label);
    })
    .sort((a, b) => menuOptionScore(b) - menuOptionScore(a))[0] ?? null;
}

function findFlowDownloadQualityOption() {
  return uniqueElements(safeQueryAll("button, [role='button'], [role='menuitem'], a"))
    .filter((element) => isVisible(element) && !isDisabled(element))
    .filter((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return downloadQualityLabelLooksUsable(label);
    })
    .sort((a, b) => downloadQualityScore(b) - downloadQualityScore(a))[0] ?? null;
}

function downloadQualityLabelLooksUsable(label: string) {
  if (!/\b(?:\d{3,4}p|original size|mp4|video)\b/.test(label)) return false;
  if (/upgrade|upsell|unavailable|disabled|animated gif|gif\b/.test(label)) return false;
  return true;
}

function downloadQualityScore(element: HTMLElement) {
  const label = normalizeOptionText(elementLabel(element));
  const originalBonus = /original size/.test(label) ? 10_000 : 0;
  const p360Bonus = /\b360p\b/.test(label) ? 8_000 : 0;
  const videoBonus = /mp4|video/.test(label) ? 2_000 : 0;
  const qualityMatch = label.match(/\b(\d{3,4})p\b/);
  const quality = qualityMatch ? Number(qualityMatch[1]) : 0;
  return originalBonus + p360Bonus + videoBonus + Math.min(quality, 1080);
}

function flowMenuDownloadOptionLooksDirect(element: HTMLElement) {
  const label = normalizeOptionText(elementLabel(element));
  return /download_for_offline|save video|export/.test(label) && !/\bdownload\b\s*$/.test(label);
}

function controlPriorityScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const label = normalizeOptionText(elementLabel(element));
  return rect.left + (window.innerHeight - rect.top) + (/download|download_for_offline/.test(label) ? 10_000 : 0);
}

function menuOptionScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const role = normalizeOptionText(element.getAttribute("role") || "");
  const label = normalizeOptionText(elementLabel(element));
  const menuBonus = /menuitem|option/.test(role) || element.closest("[role='menu'], [role='listbox']") ? 5000 : 0;
  return menuBonus + (/\bdownload\b|download_for_offline/.test(label) ? 10_000 : 0) - rect.top;
}

function describeVisibleControls(root: ParentNode) {
  return deepQueryAll<HTMLElement>("button, [role='button'], a", root)
    .filter(isVisible)
    .map(describeElement)
    .slice(0, 20);
}

function describeVisibleMenuControls() {
  return safeQueryAll("button, [role='button'], [role='menuitem'], a")
    .filter(isVisible)
    .map(describeElement)
    .slice(-30);
}

async function downloadPageResourceUrl(
  url: string,
  filename: string,
  payload: PromptPayload
): Promise<RuntimeResponse<{ downloadId: number; state?: string }>> {
  const expectationId = `page-url-download-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const registered = await sendRuntimeMessage({
    type: "REGISTER_EXPECTED_FLOW_DOWNLOAD",
    expectationId,
    filename,
    folder: payload.folderName,
    filePrefix: payload.filePrefix,
    autoChangeFileName: payload.autoChangeFileName
  });
  if (!registered.success) return { success: false, error: registered.error };

  try {
    triggerPageUrlDownload(url, filename);
    return await sendRuntimeMessage<{ downloadId: number; state?: string }>({
      type: "WAIT_EXPECTED_FLOW_DOWNLOAD",
      expectationId,
      timeoutMs: 12 * 60 * 1000
    });
  } finally {
    await sendRuntimeMessage({ type: "CLEAR_EXPECTED_FLOW_DOWNLOAD", expectationId }).catch(() => undefined);
  }
}

function triggerPageUrlDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => anchor.remove(), 1000);
}

function outputFilename(payload: PromptPayload, index: number, resourceIndex: number, resourceCount: number) {
  const downloadIndex = payload.originalIndex ?? index;
  const extension = payload.mode.includes("video") ? "mp4" : "png";
  return `${String(downloadIndex + 1).padStart(3, "0")}_${slug(payload.prompt)}${resourceCount > 1 ? `_${resourceIndex + 1}` : ""}.${extension}`;
}

async function scanCharacters(selectors: FlowSelectors) {
  const tab = findButtonByText(["character", "characters"]) ?? findFirst(selectors.characterTabButtons);
  if (tab) {
    await clickElement(tab);
    await sleep(800);
  }

  const names = new Set<string>();
  for (const selector of selectors.characterNameItems) {
    safeQueryAll(selector).forEach((element) => {
      const text = element instanceof HTMLImageElement ? element.alt : element.textContent;
      const value = text?.trim();
      if (value) names.add(value);
    });
  }
  return [...names].slice(0, 200);
}

function collectTileIds() {
  const ids = new Set<string>();
  safeQueryAll("div[data-tile-id]").forEach((element) => {
    const id = element.getAttribute("data-tile-id");
    if (id) ids.add(id);
  });
  collectGeneratedCards().forEach((element) => ids.add(generatedCardId(element)));
  return [...ids];
}

function resourceUrlsForTile(tileId: string, preferVideo: boolean) {
  const tile = tileElementForId(tileId);
  if (!tile) return [];
  if (preferVideo) {
    if (!tileLooksLikeVideoOutput(tile, elementLabel(tile))) return [];
    const videos = [
      ...(tile instanceof HTMLVideoElement ? [tile] : []),
      ...deepQueryAll<HTMLVideoElement | HTMLSourceElement>("video, video source[src]", tile)
    ];
    const anchors = deepQueryAll<HTMLAnchorElement>("a[href]", tile)
      .map((element) => element.href)
      .filter(videoResourceUrlLooksDownloadable);
    const attributeUrls = collectElementTreeUrls(tile).filter(videoResourceUrlLooksDownloadable);
    return unique([...videos
      .flatMap(videoElementUrls)
      .filter((src) => src && !src.startsWith("data:") && videoResourceUrlLooksDownloadable(src)), ...anchors, ...attributeUrls]);
  }

  const images = [
    ...(tile instanceof HTMLImageElement ? [tile] : []),
    ...deepQueryAll<HTMLImageElement>("img[src]", tile)
  ];
  return images
    .map((element) => ({ element, src: element.src, score: imageResourceScore(element, tile) }))
    .filter((item) => item.src && !item.src.startsWith("data:") && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.src)
    .filter((src) => src && !src.startsWith("data:"));
}

function collectDocumentVideoResourceUrls() {
  const videos = deepQueryAll<HTMLVideoElement | HTMLSourceElement>("video, video source[src]")
    .flatMap(videoElementUrls)
    .filter((src) => src && !src.startsWith("data:") && videoResourceUrlLooksDownloadable(src));
  const anchors = deepQueryAll<HTMLAnchorElement>("a[href]")
    .map((element) => element.href)
    .filter(videoResourceUrlLooksDownloadable);
  const attributeUrls = collectElementTreeUrls(document.body).filter(videoResourceUrlLooksDownloadable);
  const embeddedUrls = collectEmbeddedDocumentUrls().filter(videoResourceUrlLooksDownloadable);
  const performanceUrls = collectPerformanceVideoResourceUrls();
  return unique([...videos, ...anchors, ...attributeUrls, ...embeddedUrls, ...performanceUrls]);
}

async function collectNetworkVideoResourceUrls(
  group: RunningGroup,
  index: number,
  payload: PromptPayload,
  staleResourceUrls: Set<string>,
  options: { sinceMs?: number; requirePromptMatch?: boolean; requireStrictPromptMatch?: boolean; contextLabels?: string[] } = {}
) {
  const submittedAt = group.submittedAtByIndex.get(index) ?? Date.now();
  const response = await sendRuntimeMessage<{ urls: VideoResourceCandidate[] }>({
    type: "GET_RECENT_VIDEO_URLS",
    sinceMs: options.sinceMs ?? Math.max(0, submittedAt - 1000)
  });
  if (!response.success) return [];

  const requirePromptMatch = options.requirePromptMatch ?? false;
  const candidates = (response.urls ?? [])
    .filter((candidate) => candidate.url && !staleResourceUrls.has(candidate.url))
    .filter(videoResourceCandidateLooksDownloadable)
    .filter((candidate) => !requirePromptMatch || videoResourceCandidateMatchesPrompt(
      candidate,
      payload,
      Boolean(options.requireStrictPromptMatch),
      options.contextLabels ?? []
    ))
    .filter((candidate) => {
      const owner = group.videoResourceClaims.get(candidate.url);
      return owner === undefined || owner === index;
    })
    .sort((a, b) => compareVideoResourceCandidates(a, b, payload));

  rememberTrustedVideoResourceUrls(candidates);
  return claimVideoResourceUrls(group, index, candidates, payload.outputCount);
}

function videoResourceCandidateMatchesPrompt(
  candidate: VideoResourceCandidate,
  payload: PromptPayload,
  strict = false,
  contextLabels: string[] = []
) {
  if (!candidate.context) return false;
  if (!strict) return tileTextLooksRelatedToPrompt(candidate.context, payload.prompt);

  const promptLabel = normalizePromptForMatching(payload.prompt);
  const contextLabel = normalizePromptSearchText(candidate.context);
  return (
    promptLabel.length >= 24 && contextLabel.includes(promptLabel.slice(0, 70)) ||
    contextLabels.some((label) => label.length >= 12 && contextLabel.includes(label))
  );
}

function rememberTrustedVideoResourceUrls(candidates: VideoResourceCandidate[]) {
  const now = Date.now();
  const cutoff = now - 30 * 60 * 1000;
  for (const [url, at] of trustedVideoResourceUrls) {
    if (at < cutoff) trustedVideoResourceUrls.delete(url);
  }
  for (const candidate of candidates) {
    trustedVideoResourceUrls.set(candidate.url, candidate.at || now);
  }
}

function videoResourceCandidateLooksDownloadable(candidate: VideoResourceCandidate) {
  if (nonDownloadableVideoResourceUrl(candidate.url)) return false;
  if (videoResourceUrlLooksDownloadable(candidate.url)) return true;
  if (imageFileUrlPattern().test(candidate.url)) return false;
  const mimeType = candidate.mimeType ?? "";
  const resourceType = candidate.resourceType ?? "";
  const context = candidate.context ?? "";
  const sourceLooksMedia = /\bmedia\b/i.test(resourceType);
  const mimeLooksVideo = /video\/(?:mp4|webm|quicktime|x-matroska|mpeg)|application\/octet-stream/i.test(mimeType);
  const hostLooksFlowMedia = flowVideoResourceHostLooksPossible(candidate.url);
  const contextLooksVideoMedia = /video(?:Url|_url|Uri|_uri|\/mp4|\/webm|\/quicktime)|media(?:Url|_url|Uri|_uri)|download(?:Url|_url|Uri|_uri)|mimeType["':\s]+video|\.(?:mp4|webm|mov)(?:[?#"' <>)\\]|$)/i.test(context);
  return mimeLooksVideo ||
    (sourceLooksMedia && hostLooksFlowMedia) ||
    (candidate.source === "network-body" && hostLooksFlowMedia && contextLooksVideoMedia);
}

function compareVideoResourceCandidates(a: VideoResourceCandidate, b: VideoResourceCandidate, payload: PromptPayload) {
  const aPromptMatch = a.context && tileTextLooksRelatedToPrompt(a.context, payload.prompt) ? 1 : 0;
  const bPromptMatch = b.context && tileTextLooksRelatedToPrompt(b.context, payload.prompt) ? 1 : 0;
  if (aPromptMatch !== bPromptMatch) return bPromptMatch - aPromptMatch;
  const aBodyBonus = a.source === "network-body" ? 1 : 0;
  const bBodyBonus = b.source === "network-body" ? 1 : 0;
  if (aBodyBonus !== bBodyBonus) return bBodyBonus - aBodyBonus;
  return a.at - b.at;
}

function claimVideoResourceUrls(group: RunningGroup, index: number, candidates: VideoResourceCandidate[], outputCount: number) {
  const urls: string[] = [];
  for (const candidate of candidates) {
    const owner = group.videoResourceClaims.get(candidate.url);
    if (owner !== undefined && owner !== index) continue;
    group.videoResourceClaims.set(candidate.url, index);
    urls.push(candidate.url);
    if (urls.length >= outputCount) break;
  }
  return urls;
}

function collectPerformanceVideoResourceUrls() {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter(videoResourceUrlLooksDownloadable);
}

function collectElementTreeUrls(root: ParentNode) {
  const urls: string[] = [];
  const elements = root instanceof HTMLElement
    ? [root, ...deepQueryAll<HTMLElement>("*", root)]
    : deepQueryAll<HTMLElement>("*", root);
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      urls.push(...extractUrlsFromText(attribute.value));
    }
    const style = element.getAttribute("style");
    if (style) urls.push(...extractUrlsFromText(style));
  }
  return unique(urls);
}

function videoElementUrls(element: HTMLVideoElement | HTMLSourceElement) {
  if (element instanceof HTMLVideoElement) {
    return [element.currentSrc, element.src].filter(Boolean);
  }
  return [element.src].filter(Boolean);
}

function extractUrlsFromText(value: string) {
  const normalized = normalizeEscapedUrlText(value);
  const decoded = safelyDecodeUrlText(normalized);
  return unique([value, normalized, decoded]
    .flatMap(extractAbsoluteUrlsFromText))
    .filter((url) => !url.startsWith("data:"));
}

function collectEmbeddedDocumentUrls() {
  return unique([
    ...deepQueryAll<HTMLScriptElement>("script").flatMap((script) => extractUrlsFromText(script.textContent || "")),
    ...deepQueryAll<HTMLTemplateElement>("template").flatMap((template) => extractUrlsFromText(template.innerHTML || ""))
  ]);
}

function normalizeEscapedUrlText(value: string) {
  return value
    .replace(/\\u003a/gi, ":")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"");
}

function safelyDecodeUrlText(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractAbsoluteUrlsFromText(value: string) {
  return (value.match(/(?:https?:|blob:|\/\/)[^"' <>)\\]+/g) ?? [])
    .map((url) => url.startsWith("//") ? `https:${url}` : url)
    .map((url) => url.replace(/&amp;/g, "&").replace(/[),.;]+$/g, ""));
}

function videoResourceUrlLooksDownloadable(url: string) {
  if (!url || url.startsWith("data:")) return false;
  if (nonDownloadableVideoResourceUrl(url)) return false;
  if (imageFileUrlPattern().test(url)) return false;
  if (trustedVideoResourceUrls.has(url)) return true;
  if (/^blob:/i.test(url) || /\.mp4(?:[?#]|$)|\.webm(?:[?#]|$)|\.mov(?:[?#]|$)|videoplayback/i.test(url)) return true;
  return flowVideoResourceHostLooksPossible(url) && /alt=media|response-content-type=video|x-goog-signature|x-goog-credential|x-goog-algorithm|googleaccessid|signature=|token=|download|video|media/i.test(url);
}

function nonDownloadableVideoResourceUrl(url: string) {
  if (!url || url.startsWith("data:")) return true;
  return /(?:^|[/?#&=._-])(?:manifest|playlist|dash|hls)(?:[/?#&=._-]|$)/i.test(url) ||
    /\.(?:xml|m3u8|mpd|json|txt|html?|css|js|wasm|map|svg|ico)(?:[?#]|$)/i.test(url);
}

function flowVideoResourceHostLooksPossible(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return /(?:^|\.)googleusercontent\.com$|(?:^|\.)googlevideo\.com$|(?:^|\.)googleapis\.com$|(?:^|\.)storage\.googleapis\.com$|(?:^|\.)firebasestorage\.googleapis\.com$|(?:^|\.)gvt\d?\.com$|^flow\.google\.com$|^labs\.google$/i.test(hostname);
  } catch {
    return /^blob:|videoplayback/i.test(url);
  }
}

function imageFileUrlPattern() {
  return /\.(?:jpe?g|png|gif|webp|bmp|jfif)(?:[?#]|$|\s)/i;
}

function collectVisibleResourceUrls(preferVideo: boolean) {
  const tileUrls = collectTileIds().flatMap((tileId) => resourceUrlsForTile(tileId, preferVideo));
  return unique(preferVideo ? [...tileUrls, ...collectDocumentVideoResourceUrls()] : tileUrls);
}

function imageResourceScore(image: HTMLImageElement, tile: HTMLElement) {
  const rect = image.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 80) return 0;
  const src = image.src || "";
  if (/favicon|sprite|icon/i.test(src)) return 0;

  const label = normalizeOptionText(elementLabel(image));
  if (/avatar|profile|logo|icon|thumbnail|reference|input|uploaded|upload|chatgpt image/i.test(label)) return 0;

  const tileRect = tile.getBoundingClientRect();
  const area = rect.width * rect.height;
  const tileArea = Math.max(1, tileRect.width * tileRect.height);
  const coverage = Math.min(1, area / tileArea);
  const largeArea = Math.min(900, Math.round(area / 1000));
  const fillsTileBonus = coverage >= 0.35 ? 600 : 0;
  const nearTopBonus = rect.top <= tileRect.top + tileRect.height * 0.35 ? 120 : 0;
  return largeArea + fillsTileBonus + nearTopBonus;
}

interface TileStatus {
  tileId: string;
  failed: boolean;
  generating: boolean;
  playable: boolean;
  visible: boolean;
  videoLike: boolean;
  imageOnly: boolean;
  progress?: number;
  text: string;
}

function describeTileStatus(tileId: string): TileStatus | null {
  const tile = tileElementForId(tileId);
  if (!tile) return null;
  const text = elementLabel(tile).replace(/\s+/g, " ").trim();
  const progress = extractProgressPercent(tile, text);
  const visible = isVisible(tile);
  const imageOnly = tileLooksLikeImageOnlyOutput(tile, text);
  const videoLike = tileLooksLikeVideoOutput(tile, text);
  const failed = /\bfailed\b|warningfailed|couldn.t|unable|error/i.test(text);
  const hasCompletedControls = /favorite|favourite|reuse prompt|download|download_for_offline|more_vert|more options/i.test(text);
  const playable = videoLike || (!imageOnly && /reuse prompt|download|more_vert/i.test(text)) || deepQueryAll("button[aria-label*='play' i]", tile).length > 0;
  const completeByProgress = progress !== undefined && progress >= 99 && hasCompletedControls;
  const generating = !failed && !completeByProgress && (
    (progress !== undefined && progress < 99) ||
    /\b(?:generating|queued|processing|creating|loading)\b/i.test(text)
  );
  return { tileId, failed, generating, playable, visible, videoLike, imageOnly, progress, text: text.slice(0, 800) };
}

function tileLooksLikeVideoOutput(tile: HTMLElement, text: string) {
  if (tileHasVideoMedia(tile)) return true;
  if (tile.tagName.toLowerCase().includes("video")) return true;
  return /play_circle/i.test(text) && !tileLooksLikeImageOnlyOutput(tile, text);
}

function tileLooksLikeImageOnlyOutput(tile: HTMLElement, text: string) {
  if (tileHasVideoMedia(tile) || tile.tagName.toLowerCase().includes("video")) return false;
  if (imageFileUrlPattern().test(text) || /\bimage\d{1,4}[_-]/i.test(text)) return true;
  const hasImageMedia = tile instanceof HTMLImageElement || deepQueryAll("img[src], canvas", tile).length > 0;
  return hasImageMedia && !/play_circle/i.test(text);
}

function tileHasVideoMedia(tile: HTMLElement) {
  return tile instanceof HTMLVideoElement || deepQueryAll("video, video source[src]", tile).length > 0;
}

function tileElementForId(tileId: string) {
  return tileId.startsWith("flow-card-")
    ? findGeneratedCardById(tileId)
    : document.querySelector<HTMLElement>(flowSelectors.tileById(tileId));
}

function extractProgressPercent(tile: HTMLElement, text: string) {
  const ariaValue = tile.querySelector<HTMLElement>("[aria-valuenow]")?.getAttribute("aria-valuenow");
  const ariaNumber = ariaValue ? Number(ariaValue) : Number.NaN;
  if (Number.isFinite(ariaNumber)) return Math.max(0, Math.min(100, ariaNumber));
  const match = text.match(/(?:^|[^0-9])(\d{1,3})\s*%/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function collectGeneratedCards() {
  const editor = findNormalFlowComposerEditor();
  const editorRect = editor?.getBoundingClientRect();
  const cards = new Set<HTMLElement>();

  for (const element of deepQueryAll<HTMLElement>(
    [
      'div[role="button"]',
      'a[role="button"]',
      '[data-testid*="card" i]',
      'button[aria-label*="favorite" i]',
      'button[aria-label*="reuse prompt" i]',
      'button[aria-label*="download" i]',
      'button[aria-label*="play" i]',
      'button[aria-label*="more options" i]'
    ].join(",")
  )) {
    if (!isVisible(element)) continue;
    const card = generatedCardContainerForElement(element, editorRect);
    if (card) cards.add(card);
  }

  for (const media of deepQueryAll<HTMLElement>("img[src], video, canvas")) {
    if (!isVisible(media) || !generatedMediaElementLooksValid(media, editorRect)) continue;
    cards.add(generatedCardContainerForElement(media, editorRect) ?? media);
  }

  return [...cards].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 60;
  });
}

function generatedCardContainerForElement(element: HTMLElement, editorRect?: DOMRect) {
  let current: HTMLElement | null = element;
  let best: HTMLElement | null = null;
  for (let depth = 0; current && depth < 7; depth += 1, current = parentElementOrHost(current)) {
    if (!isVisible(current) || current === document.body) continue;
    const rect = current.getBoundingClientRect();
    if (!isAwayFromComposer(rect, editorRect)) continue;
    if (rect.width > window.innerWidth * 0.75 || rect.height > window.innerHeight * 0.75) break;
    if (generatedCardLooksValid(current, editorRect)) best = current;
  }
  return best;
}

function generatedCardLooksValid(element: HTMLElement, editorRect?: DOMRect) {
  const rect = element.getBoundingClientRect();
  const text = (element.textContent || "").trim();
  const label = elementLabel(element);
  const hasGeneratedMedia = deepQueryAll<HTMLElement>("img[src], video, canvas", element)
    .some((media) => generatedMediaElementLooksValid(media, editorRect));
  const mediaLabel = /^(image|video)\b/i.test(text) || /\b(image|video)\b/i.test(label);
  const playableVideoCard =
    /play_circle|reuse prompt|download|favorite|more_vert|keyboard_return/i.test(label) &&
    normalizePromptForMatching(label.replace(/play_circle|favorite|redo|more_vert|keyboard_return/gi, "")).length >= 8;
  const largeEnough = rect.width >= 140 && rect.height >= 80;
  return largeEnough && isAwayFromComposer(rect, editorRect) && (hasGeneratedMedia || mediaLabel || playableVideoCard);
}

function generatedMediaElementLooksValid(element: HTMLElement, editorRect?: DOMRect) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 80) return false;
  if (!isAwayFromComposer(rect, editorRect)) return false;
  const label = normalizeOptionText(elementLabel(element));
  if (/avatar|profile|logo|icon|thumbnail|reference|input|uploaded|upload|google account/.test(label)) return false;
  if (element instanceof HTMLImageElement) {
    const src = element.src || "";
    if (!src || src.startsWith("data:")) return false;
    if (/favicon|sprite|icon|avatar|profile/i.test(src)) return false;
  }
  return true;
}

function isAwayFromComposer(rect: DOMRect, editorRect?: DOMRect) {
  return !editorRect || rect.bottom < editorRect.top - 40 || rect.top > editorRect.bottom + 80;
}

function findGeneratedCardById(tileId: string) {
  return collectGeneratedCards().find((element) => generatedCardId(element) === tileId) ?? null;
}

function generatedCardId(element: HTMLElement) {
  const stable = generatedCardStableId(element);
  if (stable) {
    generatedCardIds.set(element, stable);
    return stable;
  }
  const rect = element.getBoundingClientRect();
  const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const id = [
    "flow-card",
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    stableHash(text)
  ].join("-");
  generatedCardIds.set(element, id);
  return id;
}

function generatedCardStableId(element: HTMLElement) {
  const mediaUrl = primaryGeneratedMediaUrl(element);
  if (mediaUrl) return `flow-card-media-${stableHash(mediaUrl)}`;

  const label = normalizePromptForMatching(
    elementLabel(element).replace(/play_circle|favorite|redo|more_vert|keyboard_return|download/gi, "")
  );
  if (label.length < 8 || /\b\d{1,3}\s*%\b|generating|queued|processing|creating|loading/i.test(label)) {
    return null;
  }
  const hasCompletedCardControls = /favorite|reuse prompt|download|more_vert|play_circle/i.test(elementLabel(element));
  return hasCompletedCardControls ? `flow-card-label-${stableHash(label)}` : null;
}

function primaryGeneratedMediaUrl(element: HTMLElement) {
  const media = [
    ...(element instanceof HTMLImageElement || element instanceof HTMLVideoElement ? [element] : []),
    ...deepQueryAll<HTMLImageElement | HTMLVideoElement | HTMLSourceElement>("img[src], video, video source[src]", element)
  ];
  return media
    .flatMap((item) => item instanceof HTMLImageElement ? [item.src] : videoElementUrls(item))
    .find((src) => src && !src.startsWith("data:") && !/favicon|sprite|icon|avatar|profile/i.test(src)) ?? "";
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function resultFor(payload: PromptPayload, index: number, status: PromptResult["status"]): PromptResult {
  return {
    id: payload.id,
    index: payload.originalIndex ?? index,
    prompt: payload.prompt,
    status,
    percentage: 0,
    payload: { ...payload, originalIndex: payload.originalIndex ?? index }
  };
}

function updateResult(group: RunningGroup, index: number, update: Partial<PromptResult>) {
  group.results[index] = { ...group.results[index], ...update };
  publish(group);
}

function publish(group: RunningGroup) {
  const snapshot: PromptGroup = {
    id: group.id,
    status: group.status,
    createdAt: group.createdAt,
    totalCount: group.totalCount,
    processedCount: group.processedCount,
    currentIndex: group.currentIndex,
    results: group.results,
    isCancelling: group.isCancelling
  };
  sendRuntimeMessage({ type: "PROMPT_GROUP_UPDATE", group: snapshot }).catch(() => undefined);
}

async function waitForPromptDelay(group: RunningGroup, index: number) {
  const min = group.promptDelaySecondsMin;
  const max = Math.max(min, group.promptDelaySecondsMax);
  const delay = max === 0 ? 0 : min + Math.random() * (max - min);
  log("debug", "Applying queue delay before next Flow submission", {
    delaySeconds: Number(delay.toFixed(2)),
    min,
    max
  }, group.id, index);
  const end = Date.now() + delay * 1000;
  while (!group.isCancelling && Date.now() < end) await sleep(250);
}

function findFirst(selectors: string[]) {
  for (const selector of selectors) {
    const element = safeQuery(selector);
    if (element && isVisible(element)) return element as HTMLElement;
  }
  return null;
}

function findButtonByText(words: string[]) {
  const lowerWords = words.map((word) => word.toLowerCase());
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], [aria-label]")]
    .find((element) => {
      if (!isVisible(element)) return false;
      const text = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
      return lowerWords.some((word) => text.includes(word));
    }) ?? null;
}

async function clickTextOption(text: string, options: { exact?: boolean } = {}) {
  if (!text) return false;
  const lower = normalizeOptionText(text);
  const option = findConfigOptionCandidates()
    .map((element) => ({ element, label: normalizeOptionText(elementLabel(element)) }))
    .filter(({ element, label }) => {
      if (!isVisible(element)) return false;
      return configOptionLabelMatchesRequested(label, lower, Boolean(options.exact));
    })
    .sort((a, b) => optionScore(b.element) - optionScore(a.element))[0]?.element;
  if (!option) return false;
  log("debug", "Clicking Flow option", { requested: text, exact: Boolean(options.exact), option: describeElement(option) });
  await clickElement(option);
  await sleep(200);
  return true;
}

async function clickAnyTextOption(texts: string[], options: { exact?: boolean } = {}) {
  for (const text of texts) {
    if (await clickTextOption(text, options)) return true;
  }
  return false;
}

function optionScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const editor = findNormalFlowComposerEditor();
  const editorRect = editor?.getBoundingClientRect();
  const popoverBias = editorRect && isLikelyConfigPopoverOption(element, editorRect) ? 5000 : 0;
  const composerSummaryPenalty = isComposerConfigSummary(element) ? -6000 : 0;
  const distanceFromComposer = editorRect ? Math.abs(rect.bottom - editorRect.top) + Math.abs(rect.left - editorRect.left) : 0;
  return popoverBias + composerSummaryPenalty - distanceFromComposer + rect.width;
}

function configSignature(payload: PromptPayload) {
  return [
    payload.mode,
    effectiveAspectRatio(payload),
    modelForPayload(payload),
    payload.mode.includes("video") ? payload.videoDuration : "",
    payload.outputCount
  ].join("|").toLowerCase();
}

function configLooksCompatible(label: string, payload: PromptPayload, strictOutputCount = true) {
  const normalized = normalizeOptionText(label);
  if (strictOutputCount && !outputCountAliases(payload.outputCount).some((count) => normalized.includes(count))) return false;
  if (!normalized.includes(aspectLabel(effectiveAspectRatio(payload)))) return false;
  if (isImageOutputMode(payload.mode)) return imageModelLooksCompatible(normalized, modelForPayload(payload));
  const duration = normalizeOptionText(payload.videoDuration);
  if (duration && !normalized.includes(duration)) return false;
  return videoConfigLooksCompatible(normalized, modelForPayload(payload));
}

function imageModelLooksCompatible(normalizedLabel: string, requestedModel: string) {
  const model = normalizeModelName(requestedModel);
  if (!model) return /banana|imagen/.test(normalizedLabel);
  if (model.includes("nano banana 2 lite")) return normalizedLabel.includes("nano banana 2") && normalizedLabel.includes("lite");
  if (model.includes("nano banana pro")) return normalizedLabel.includes("nano banana") && normalizedLabel.includes("pro");
  if (model.includes("nano banana 2")) {
    return normalizedLabel.includes("nano banana 2") && !normalizedLabel.includes("lite") && !normalizedLabel.includes("pro");
  }
  if (model.includes("nano banana")) return normalizedLabel.includes("nano banana");
  return normalizedLabel.includes(model);
}

function videoModelLooksCompatible(normalizedLabel: string, requestedModel: string) {
  const model = normalizeModelName(requestedModel);
  if (!model) return /video|veo|omni/.test(normalizedLabel);
  if (model.includes("omni 1.1 flash")) return normalizedLabel.includes("omni 1.1 flash") || normalizedLabel.includes("omni flash");
  return normalizedLabel.includes(model) || /video/.test(normalizedLabel);
}

function videoConfigLooksCompatible(normalizedLabel: string, requestedModel: string) {
  return /\bvideo\b/.test(normalizedLabel) || videoModelLooksCompatible(normalizedLabel, requestedModel);
}

function modelForPayload(payload: PromptPayload) {
  return isVideoOutputMode(payload.mode) ? normalizeVideoModel(payload.model) : payload.imageModel;
}

function isVideoOutputMode(mode: PromptPayload["mode"]) {
  return mode.includes("video");
}

function isImageOutputMode(mode: PromptPayload["mode"]) {
  return !isVideoOutputMode(mode);
}

function effectiveAspectRatio(payload: PromptPayload) {
  if (!isVideoOutputMode(payload.mode)) return payload.aspectRatio;
  const normalized = payload.aspectRatio.replace(/\s+/g, "");
  if (normalized === "16:9" || normalized === "4:3") return "16:9";
  return "9:16";
}

function normalizeVideoModel(model: string) {
  const normalized = normalizeOptionText(model);
  if (!normalized || normalized === "veo") return "Omni 1.1 Flash";
  if (normalized.includes("omni 1.1 flash") || normalized.includes("omni flash")) return "Omni 1.1 Flash";
  if (normalized.includes("veo 3.1") && normalized.includes("lite")) return "Veo 3.1 - Lite";
  if (normalized.includes("veo 3.1") && normalized.includes("fast")) return "Veo 3.1 - Fast";
  if (normalized.includes("veo 3.1") && normalized.includes("quality")) return "Veo 3.1 - Quality";
  return "Omni 1.1 Flash";
}

async function selectModel(modelName: string) {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return false;
  const dropdown = findModelDropdownButton();
  if (!dropdown) return false;
  if (modelLabelLooksCompatible(elementLabel(dropdown), modelName)) {
    log("debug", "Flow model already selected", { requested: modelName, dropdown: describeElement(dropdown) });
    return true;
  }
  log("debug", "Opening Flow model dropdown", describeElement(dropdown));
  await clickElement(dropdown);
  const aliases = modelAliasesForName(modelName);
  const option = await waitUntil(() => findDropdownTextOption(dropdown, aliases), 900, 100);
  if (option) {
    await clickModelDropdownOption(option, modelName, "primary");
    if (await waitForSelectedModel(modelName, dropdown)) return true;
    return selectModelWithKeyboard(modelName, aliases, dropdown);
  }
  const textTarget = await waitUntil(() => findDropdownTextRange(dropdown, aliases), 1800, 100);
  if (!textTarget) {
    log("warn", "Flow model option was not visible after opening dropdown", {
      requested: modelName,
      aliases,
      dropdown: describeElement(dropdown),
      visibleTextOptions: collectVisibleTextOptions(dropdown).slice(0, 30).map(describeElement)
    });
    return false;
  }
  await clickDropdownTextTarget(aliases, textTarget);
  if (await waitForSelectedModel(modelName, dropdown)) return true;
  return selectModelWithKeyboard(modelName, aliases, dropdown);
}

async function waitForSelectedModel(modelName: string, previousDropdown?: HTMLElement | null) {
  const settled = await waitUntil(() => {
    const selected = findModelDropdownButton();
    return selected ? modelLabelLooksCompatible(elementLabel(selected), modelName) : false;
  }, 1800, 120);
  if (settled) return true;

  const currentDropdown = findModelDropdownButton();
  const visibleModelOptions = collectVisibleTextOptions()
    .filter((element) => /omni|veo|banana|imagen/i.test(elementLabel(element)));
  const configLabel = elementLabel(findComposerConfigButton() ?? document.body);
  const compactVideoConfig = videoModelLooksCompatible(normalizeOptionText(configLabel), modelName) && !visibleModelOptions.length;
  const compatibleCompactImageConfig = imageModelLooksCompatible(normalizeOptionText(configLabel), modelName) && !visibleModelOptions.length;
  if (compactVideoConfig || compatibleCompactImageConfig) {
    log("debug", "Flow model menu closed after selection; accepting compact composer state", {
      requested: modelName,
      previousDropdown: previousDropdown ? describeElement(previousDropdown) : null,
      composerConfig: findComposerConfigButton() ? describeElement(findComposerConfigButton()!) : null
    });
    return true;
  }

  if (!settled) {
    log("warn", "Flow model selection did not settle", {
      requested: modelName,
      dropdown: currentDropdown ? describeElement(currentDropdown) : null,
      options: visibleModelOptions.slice(0, 20).map(describeElement)
    });
  }
  return false;
}

async function selectModelWithKeyboard(modelName: string, aliases: string[], previousDropdown?: HTMLElement | null) {
  let dropdown = findLiveElement(findModelDropdownButton()) ?? findLiveElement(previousDropdown);
  if (!dropdown) {
    const opened = await openComposerConfiguration();
    if (!opened) return false;
    dropdown = findLiveElement(findModelDropdownButton());
  }
  if (!dropdown) return false;
  const normalizedAliases = aliases.map(normalizeOptionText);
  const optionsVisible = () => dropdown
    ? collectVisibleTextOptions(dropdown).some((element) => modelTextMatchScore(normalizeOptionText(elementLabel(element)), normalizedAliases) > 0)
    : false;
  if (!optionsVisible()) {
    log("debug", "Reopening Flow model dropdown for keyboard selection", describeElement(dropdown));
    await clickElement(dropdown);
    await waitUntil(optionsVisible, 1200, 100);
  }

  const optionLabels = uniqueModelOptionLabels(dropdown);
  const targetIndex = optionLabels.findIndex((label) => modelTextMatchScore(label, normalizedAliases) > 0);
  if (targetIndex < 0) {
    log("warn", "Flow model keyboard fallback could not find target option", {
      requested: modelName,
      aliases,
      options: optionLabels
    });
    return false;
  }

  log("debug", "Selecting Flow model with keyboard fallback", {
    requested: modelName,
    targetIndex,
    options: optionLabels
  });
  await sendKey("Home", "Home", 36);
  await sleep(100);
  for (let index = 0; index < targetIndex; index += 1) {
    await sendKey("ArrowDown", "ArrowDown", 40);
    await sleep(70);
  }
  await sendKey("Enter", "Enter", 13);
  if (await waitForSelectedModel(modelName, dropdown)) return true;

  dropdown = findLiveElement(findModelDropdownButton()) ?? dropdown;
  if (!optionsVisible()) {
    await clickElement(dropdown);
    await waitUntil(optionsVisible, 1200, 100);
  }
  const liveOption = findDropdownTextOption(dropdown, aliases);
  if (!liveOption) return false;
  await clickModelDropdownOption(liveOption, modelName, "fallback");
  return waitForSelectedModel(modelName, dropdown);
}

function findLiveElement(element?: HTMLElement | null) {
  if (!element || !element.isConnected || !isVisible(element)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
}

function uniqueModelOptionLabels(anchor: HTMLElement) {
  const seen = new Set<string>();
  return collectModelMenuOptions(anchor)
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    })
    .map((element) => normalizeOptionText(elementLabel(element)))
    .filter((label) => {
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    });
}

function modelLabelLooksCompatible(label: string, requestedModel: string) {
  const normalizedModel = normalizeModelName(requestedModel);
  const normalizedLabel = normalizeOptionText(label);
  if (/banana|imagen/.test(normalizedModel)) return imageModelLooksCompatible(normalizedLabel, requestedModel);
  return videoModelLooksCompatible(normalizedLabel, requestedModel);
}

function findModelDropdownButton() {
  return [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter(isVisible)
    .filter((element) => {
      const role = element.getAttribute("role") || "";
      if (/menuitem|option|radio|tab/i.test(role)) return false;
      const aria = element.getAttribute("aria-label") || "";
      const label = elementLabel(element);
      const rect = element.getBoundingClientRect();
      return /select model family/i.test(aria) || (/banana|imagen|veo|omni|model/i.test(label) && /arrow_drop_down/i.test(label) && rect.width > 120);
    })
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function normalizeOptionText(value: string) {
  return value.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function normalizePromptForMatching(value: string) {
  return normalizePromptMatchText(value)
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function normalizePromptSearchText(value: string) {
  return normalizeOptionText(value)
    .replace(/play_circle|favorite|redo|more_vert|keyboard_return|download/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePromptMatchText(value: string) {
  const parts = value.split(/[–—]/).map((part) => part.trim()).filter(Boolean);
  return normalizeOptionText(parts.length > 1 ? parts[parts.length - 1] : value)
    .replace(/play_circle|favorite|redo|more_vert|keyboard_return|download/g, " ")
    .replace(/(?:^|\s)(image|video)(?=[a-z0-9])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

const promptMatchStopWords = new Set([
  "with",
  "from",
  "that",
  "this",
  "they",
  "their",
  "there",
  "where",
  "shown",
  "small",
  "large",
  "glowing",
  "warm",
  "soft",
  "clean",
  "style",
  "semi",
  "flat",
  "digital",
  "illustration",
  "storybook",
  "explainer",
  "lighting",
  "bold",
  "linework",
  "expressive",
  "indian",
  "characters",
  "earthy",
  "color",
  "palette",
  "browns",
  "yellows",
  "greens",
  "modest",
  "urban",
  "office",
  "setting",
  "unless",
  "specified",
  "image",
  "video"
]);

const promptMatchGenericTokens = new Set([
  "both",
  "age",
  "emergency",
  "friend",
  "holding",
  "human",
  "identical",
  "icon",
  "nearby",
  "people",
  "person",
  "phone",
  "same",
  "shown",
  "sitting",
  "standing",
  "together",
  "using",
  "village",
  "young",
  "man",
  "karan",
  "nitin"
]);

function tileTextLooksRelatedToPrompt(tileText: string, prompt: string) {
  const promptLabel = normalizePromptForMatching(prompt);
  const tileLabel = normalizePromptForMatching(tileText);
  if (promptLabel && tileLabel.includes(promptLabel)) return true;

  const promptTokens = significantPromptTokens(prompt);
  const tileTokens = significantPromptTokens(tileText);
  if (promptTokens.length === 0 || tileTokens.length === 0) return false;

  const tileTokenSet = new Set(tileTokens);
  const sharedTokens = promptTokens.filter((token) => tileTokenSet.has(token));
  const shared = sharedTokens.length;
  const sharedRatio = shared / Math.min(promptTokens.length, tileTokens.length);
  const distinctivePromptTokens = promptTokens.filter((token) => !promptMatchGenericTokens.has(token));
  const distinctiveTileTokenSet = new Set(tileTokens.filter((token) => !promptMatchGenericTokens.has(token)));
  const distinctiveShared = distinctivePromptTokens.filter((token) => distinctiveTileTokenSet.has(token)).length;
  const distinctiveRatio = distinctiveShared / Math.max(1, Math.min(distinctivePromptTokens.length, distinctiveTileTokenSet.size));
  const shortTitleMatch = distinctiveTileTokenSet.size <= 4 &&
    distinctiveShared >= 2 &&
    distinctiveRatio >= 0.6 &&
    sharedRatio >= 0.4;
  return (
    shortTitleMatch ||
    (distinctiveShared >= 3 && distinctiveRatio >= 0.45 && sharedRatio >= 0.3) ||
    (distinctiveShared >= 4 && sharedRatio >= 0.45) ||
    (shared >= 5 && sharedRatio >= 0.7)
  );
}

function significantPromptTokens(value: string) {
  return unique(normalizePromptMatchText(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .map(normalizePromptToken)
    .filter((token) => token.length >= 3 && !promptMatchStopWords.has(token))
    .slice(0, 40));
}

function normalizePromptToken(value: string) {
  if (/^(phones|smartphone|smartphones)$/.test(value)) return "phone";
  if (/^(men|boys|male)$/.test(value)) return "man";
  if (/^(bike|bikes|bicycle|bicycles)$/.test(value)) return "bike";
  if (/^(ride|rides|riding|ridden)$/.test(value)) return "ride";
  if (/^(scroll|scrolls|scrolling|scrolled)$/.test(value)) return "scroll";
  if (/^(coins|coin|money|income|earning|earnings|cash)$/.test(value)) return "money";
  if (/^(question|questions|wonder|wondering|wondered)$/.test(value)) return "question";
  if (/^(thought|thoughts|thoughtful|thoughtfully|think|thinks|thinking)$/.test(value)) return "thought";
  if (/^(appear|appears|appearing|appeared)$/.test(value)) return "appear";
  if (/^(grow|grows|growing|grew|grown)$/.test(value)) return "grow";
  if (/^(rise|rises|rising|rose|risen)$/.test(value)) return "rise";
  if (/^(increase|increases|increasing|increased)$/.test(value)) return "increase";
  if (/^(leak|leaks|leaking|leaked)$/.test(value)) return "leak";
  if (/^(pour|pours|pouring|poured)$/.test(value)) return "pour";
  if (/^(point|points|pointing|pointed)$/.test(value)) return "point";
  if (/^(path|paths|choose|choosing|choice|choices)$/.test(value)) return "path";
  if (/^(follow|follows|followed|following)$/.test(value)) return "follow";
  if (/^(shrink|shrinks|shrinking|shrunken)$/.test(value)) return "shrink";
  if (/^(responsibility|responsibilities)$/.test(value)) return "responsibility";
  const normalized = value
    .replace(/^re$/, "")
    .replace(/^redo$/, "")
    .replace(/^bars$/, "bar")
    .replace(/s$/, "");
  return normalized;
}

function normalizeModelName(value: string) {
  const normalized = normalizeOptionText(value);
  if (normalized === "imagen" || normalized.includes("imagen 4")) return "nano banana 2 lite";
  if (normalized.includes("omni flash")) return "omni 1.1 flash";
  return normalized;
}

function aspectLabel(value: string) {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  const map: Record<string, string> = {
    "16:9": "crop_16_9",
    "4:3": "crop_landscape",
    "1:1": "crop_square",
    "3:4": "crop_portrait",
    "9:16": "crop_9_16"
  };
  return map[normalized] ?? normalized;
}

function aspectAliases(value: string) {
  return Array.from(new Set([aspectLabel(value), value.replace(/\s+/g, "")]));
}

function outputCountAliases(value: number) {
  return Array.from(new Set([`x${value}`, `${value}x`]));
}

function modeAliases(mode: PromptPayload["mode"]) {
  if (mode.includes("video")) return ["video"];
  return ["image"];
}

function videoInputAliases(mode: PromptPayload["mode"]) {
  if (mode === "text-to-video" || mode === "image-to-video") {
    return ["ingredients", "chrome_extension"];
  }
  return [];
}

function modelAliasesForName(modelName: string) {
  const normalized = normalizeOptionText(modelName);
  if (normalized.includes("nano banana pro")) return ["Nano Banana Pro", "Banana Pro"];
  if (normalized.includes("nano banana 2 lite") || normalized.includes("imagen 4")) return ["Nano Banana 2 Lite", "Banana 2 Lite"];
  if (normalized.includes("nano banana 2")) return ["Nano Banana 2", "Banana 2"];
  if (normalized.includes("omni 1.1 flash") || normalized.includes("omni flash")) return ["Omni 1.1 Flash", "Omni Flash"];
  if (normalized.includes("veo 3.1") && normalized.includes("lite")) return ["Veo 3.1 - Lite", "Veo 3.1 Lite"];
  if (normalized.includes("veo 3.1") && normalized.includes("fast")) return ["Veo 3.1 - Fast", "Veo 3.1 Fast"];
  if (normalized.includes("veo 3.1") && normalized.includes("quality")) return ["Veo 3.1 - Quality", "Veo 3.1 Quality"];
  return [modelName];
}

function findDropdownTextOption(dropdown: HTMLElement, aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeOptionText);
  return collectModelMenuOptions(dropdown)
    .map((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return { element, matchScore: modelTextMatchScore(label, normalizedAliases) };
    })
    .filter((item) => item.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || dropdownOptionScore(dropdown, b.element) - dropdownOptionScore(dropdown, a.element))[0]?.element ?? null;
}

async function clickModelDropdownOption(option: HTMLElement, modelName: string, phase: "primary" | "fallback") {
  const clickable = findClickableDropdownAncestor(option) ?? option;
  const rect = clickable.getBoundingClientRect();
  log("debug", "Clicking Flow model dropdown option", {
    requested: modelName,
    phase,
    option: describeElement(option),
    clickable: describeElement(clickable)
  });
  dispatchDomPointerClick(clickable);
  await clickAt(rect.left + rect.width * 0.35, rect.top + rect.height / 2, clickable);
  await sleep(80);
  if (isVisible(clickable)) {
    await clickAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clickable);
  }
  await sleep(250);
}

function collectModelMenuOptions(anchor?: HTMLElement) {
  return collectVisibleTextOptions(anchor)
    .filter((element) => {
      const role = element.getAttribute("role") || "";
      const label = normalizeOptionText(elementLabel(element));
      return /menuitem|option/i.test(role) && /omni|veo|banana|imagen/i.test(label);
    });
}

interface DropdownTextTarget {
  rect: DOMRect;
  text: string;
  element: HTMLElement;
}

async function clickDropdownTextTarget(aliases: string[], target: DropdownTextTarget) {
  const clickable = findClickableDropdownAncestor(target.element) ?? target.element;
  const rect = clickable.getBoundingClientRect();
  log("debug", "Clicking Flow model text option", {
    requested: aliases,
    text: target.text,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    option: describeElement(clickable)
  });
  await clickAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clickable);
  await sleep(250);
}

function findDropdownTextRange(dropdown: HTMLElement, aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeOptionText);
  const dropdownRect = dropdown.getBoundingClientRect();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalizeOptionText(node.textContent || "");
      if (!text || modelTextMatchScore(text, normalizedAliases) === 0) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
      if (dropdown.contains(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const matches: Array<DropdownTextTarget & { score: number }> = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    range.detach();
    if (rect.width < 12 || rect.height < 10) continue;
    const nearDropdown =
      rect.top >= dropdownRect.top - 360 &&
      rect.top <= dropdownRect.bottom + 280 &&
      rect.right >= dropdownRect.left - 30 &&
      rect.left <= dropdownRect.right + 80;
    if (!nearDropdown) continue;
    const text = node.textContent || "";
    const matchScore = modelTextMatchScore(normalizeOptionText(text), normalizedAliases);
    matches.push({
      rect,
      text,
      element: parent,
      score: matchScore + (rect.top >= dropdownRect.bottom ? 500 : 0) - Math.abs(rect.left - dropdownRect.left)
    });
  }

  return matches.sort((a, b) => b.score - a.score)[0] ?? null;
}

function modelTextMatchScore(label: string, normalizedAliases: string[]) {
  let best = 0;
  for (const alias of normalizedAliases) {
    if (!alias) continue;
    const isBananaAlias = alias.includes("banana");
    if (isBananaAlias) {
      const aliasLite = alias.includes("lite");
      const aliasPro = alias.includes("pro");
      if (aliasLite !== label.includes("lite")) continue;
      if (aliasPro !== label.includes("pro")) continue;
    }
    if (label === alias) best = Math.max(best, 3000 + alias.length);
    else if (label.includes(alias)) best = Math.max(best, 1000 + alias.length);
  }
  return best;
}

function findClickableDropdownAncestor(element: HTMLElement) {
  let current: HTMLElement | null = element;
  let best: HTMLElement | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
    if (!isVisible(current)) continue;
    const rect = current.getBoundingClientRect();
    const role = current.getAttribute("role") || "";
    const clickableRole = /button|option|menuitem|radio/.test(role);
    const clickableTag = current.tagName.toLowerCase() === "button";
    const rowSized = rect.width >= 120 && rect.height >= 24 && rect.height <= 72;
    if ((clickableRole || clickableTag || rowSized) && !isDisabled(current)) {
      const score = (rowSized ? 1000 : 0) + (clickableRole || clickableTag ? 500 : 0) + rect.width - Math.abs(rect.height - 42);
      if (score > bestScore) {
        best = current;
        bestScore = score;
      }
    }
  }
  return best;
}

function dispatchDomPointerClick(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  };
  element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerdown", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", options));
  element.dispatchEvent(new PointerEvent("pointerup", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", options));
  element.dispatchEvent(new MouseEvent("click", options));
}

function collectVisibleTextOptions(anchor?: HTMLElement) {
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], div, span")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      if (element === anchor || element.contains(anchor ?? null)) return false;
      const label = normalizeOptionText(elementLabel(element));
      if (!label || label.length > 80) return false;
      if (!/banana|imagen|omni|veo|model|flash|leaving/i.test(label)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 12) return false;
      if (!anchor) return true;
      const anchorRect = anchor.getBoundingClientRect();
      const horizontallyAligned = rect.right >= anchorRect.left - 30 && rect.left <= anchorRect.right + 80;
      const nearDropdown = rect.top >= anchorRect.top - 360 && rect.top <= anchorRect.bottom + 260;
      return horizontallyAligned && nearDropdown;
    });
}

function dropdownOptionScore(dropdown: HTMLElement, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const dropdownRect = dropdown.getBoundingClientRect();
  const area = rect.width * rect.height;
  const rowShape = rect.width >= dropdownRect.width * 0.55 && rect.height >= 24 ? 1000 : 0;
  const nearDropdown = Math.max(0, 700 - Math.abs(rect.top - dropdownRect.top));
  const xDistance = Math.abs(rect.left - dropdownRect.left);
  return rowShape + nearDropdown - xDistance - area / 10000;
}

function findConfigOptionCandidates() {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='option'], [role='menuitem'], [role='tab']")
  ].filter((element) => isVisible(element) && !looksLikeGeneratedMediaLabelOption(element));
  const popoverOptions = findConfigPopoverOptions();
  return popoverOptions.length ? popoverOptions : candidates.filter((element) => !isComposerConfigSummary(element));
}

function findConfigPopoverOptions() {
  const editor = findNormalFlowComposerEditor();
  const editorRect = editor?.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='option'], [role='menuitem'], [role='tab']")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      if (looksLikeGeneratedMediaLabelOption(element)) return false;
      if (!editorRect) return !isComposerConfigSummary(element);
      return isLikelyConfigPopoverOption(element, editorRect);
    })
    .sort((a, b) => optionScore(b) - optionScore(a));
}

function isLikelyConfigPopoverOption(element: HTMLElement, editorRect: DOMRect) {
  const rect = element.getBoundingClientRect();
  const label = elementLabel(element);
  if (looksLikeGeneratedMediaLabelOption(element, rect, label)) return false;
  const inComposerPopover =
    rect.bottom <= editorRect.top + 30 &&
    rect.top >= editorRect.top - 760 &&
    rect.left >= editorRect.left - 80 &&
    rect.right <= editorRect.right + 260;
  const looksLikeFlowOption = /image|video|frame|ingredient|crop_|16:9|4:3|1:1|3:4|9:16|x[1-4]|[1-4]x|banana|imagen|omni|veo|4s|6s|8s|10s/i.test(label);
  return inComposerPopover && looksLikeFlowOption && !/create|generate|submit|arrow_forward/i.test(label);
}

function configOptionLabelMatchesRequested(label: string, requested: string, exact: boolean) {
  if (exact) return label === requested;
  const compactLabel = label.replace(/\s+/g, "");
  const compactRequested = requested.replace(/\s+/g, "");
  if (compactRequested === "image") return compactLabel === "imageimage" || label === "image";
  if (compactRequested === "video") return compactLabel === "videocamvideo" || label === "video";
  return label.includes(requested);
}

function looksLikeGeneratedMediaLabelOption(element: HTMLElement, rect = element.getBoundingClientRect(), label = elementLabel(element)) {
  const role = normalizeOptionText(element.getAttribute("role") || "");
  if (role !== "button") return false;
  const compact = normalizeOptionText(label).replace(/\s+/g, "");
  if (compact === "imageimage" || compact === "videocamvideo") return false;
  return /^(image|video)[a-z0-9]/.test(compact) && rect.height <= 26 && rect.width >= 80;
}

function isComposerConfigSummary(element: HTMLElement) {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return false;
  const rect = element.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const label = elementLabel(element);
  if (rect.width > 380 || rect.height > 96 || looksLikeGenerationCard(element, rect, label)) return false;
  return (
    rect.top >= editorRect.top - 90 &&
    rect.top <= editorRect.bottom + 70 &&
    rect.left >= editorRect.left &&
    rect.left <= editorRect.right + 260 &&
    /banana|imagen|veo|omni|crop_|16:9|9:16|x\d|image|video/i.test(label) &&
    !/arrow_forward|create|generate|submit/i.test(label)
  );
}

async function clickElement(element: Element) {
  if (isNativeFilePickerTrigger(element)) {
    log("warn", "Blocked Flow upload control to avoid opening the native file picker", describeElement(element));
    return;
  }
  const rect = element.getBoundingClientRect();
  await clickAt(rect.left + rect.width / 2, rect.top + rect.height / 2, element);
}

async function clickAt(x: number, y: number, element?: Element) {
  if (element && isNativeFilePickerTrigger(element)) {
    log("warn", "Blocked fallback upload click to avoid opening the native file picker", describeElement(element));
    return;
  }
  const result = await sendRuntimeMessage({ type: "CLICK_AT", x, y });
  if (!result.success) {
    log("warn", "Debugger click failed, using DOM click", { error: result.error, element: element ? describeElement(element) : { x, y } });
    if (element && !isNativeFilePickerTrigger(element)) (element as HTMLElement).click();
  }
}

function isNativeFilePickerTrigger(element: Element) {
  const tag = element.tagName.toLowerCase();
  const role = normalizeOptionText(element.getAttribute("role") || "");
  if (tag !== "button" && tag !== "label" && !/button|menuitem|option/.test(role)) return false;
  const label = normalizeOptionText(elementLabel(element));
  const compact = label.replace(/\s+/g, "");
  return (/\bupload media\b|from computer|select files?|browse files?/.test(label) || compact.includes("uploaduploadmedia")) &&
    !/downloads?|download|uploaded media|media library|drive_folder_uploaduploads/.test(label);
}

async function sendKey(key: string, code: string, keyCode: number, modifiers = 0) {
  await sendRuntimeMessage({ type: "SEND_KEY", key, code, keyCode, modifiers });
}

async function focusComposerArea() {
  const editor = findNormalFlowComposerEditor();
  if (!editor || !isInViewport(editor)) return false;
  await clickElement(editor);
  await sleep(120);
  return true;
}

function findComposerSubmitButton() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return findFallbackComposerSubmitButton();
  const editorRect = editor.getBoundingClientRect();
  let container: Element | null = editor;

  for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
    const containerRect = container.getBoundingClientRect();
    if (containerRect.width < editorRect.width || containerRect.height < editorRect.height) continue;
    const buttons = [...container.querySelectorAll<HTMLElement>("button, [role='button'], img")]
      .filter((button) => isVisible(button));
    const createButtons = buttons
      .map((button) => ({ button, label: elementLabel(button), rect: button.getBoundingClientRect(), score: 0 }))
      .filter((item) => {
        const rightEdgeControl = item.rect.left >= editorRect.right - 90;
        const belowOrInsideComposer = item.rect.top >= editorRect.top - 40 && item.rect.top <= editorRect.bottom + 80;
        const explicitSubmit = /arrow_forward|generate|submit/i.test(item.label);
        const textCreateSubmit = /create/i.test(item.label) && rightEdgeControl && !/add_2|add media|add image/i.test(item.label);
        const iconOnlySubmit = !item.label && rightEdgeControl && item.rect.width <= 56 && item.rect.height <= 56;
        return item.rect.left >= editorRect.left && belowOrInsideComposer && (explicitSubmit || textCreateSubmit || iconOnlySubmit);
      })
      .map((item) => ({
        ...item,
        score:
          item.rect.left +
          item.rect.top +
          (item.rect.left > editorRect.right - 90 ? 500 : 0) +
          (item.rect.top > editorRect.bottom - 90 ? 500 : 0) -
          Math.abs(item.rect.width - item.rect.height) +
          (/arrow_forward/i.test(item.label) ? 1000 : 0)
      }))
      .sort((a, b) => b.score - a.score);
    if (createButtons[0]) return createButtons[0].button;
  }

  log("debug", "Composer submit candidates", {
    editor: describeElement(editor),
    candidates: [...document.querySelectorAll<HTMLElement>("button, [role='button'], img")]
      .filter(isVisible)
      .slice(-30)
      .map(describeElement)
  });
  return null;
}

function findComposerAddMediaButton() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return null;
  const editorRect = editor.getBoundingClientRect();
  const container = findComposerContainer();
  const scope = container ?? document;
  return [...scope.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((button) => {
      if (!isVisible(button)) return false;
      const rect = button.getBoundingClientRect();
      const label = elementLabel(button);
      const nearEditor = rect.top >= editorRect.top - 70 && rect.top <= editorRect.bottom + 100;
      const leftOfPrompt = rect.right <= editorRect.left + 80;
      const looksLikeAdd = /add|upload|media|image|\+|add_2/i.test(label);
      const notSubmit = /add_2/i.test(label) || !/arrow_forward|generate|submit/i.test(label);
      return nearEditor && leftOfPrompt && looksLikeAdd && notSubmit;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs(ar.left - editorRect.left) + Math.abs(ar.top - editorRect.top) -
        (Math.abs(br.left - editorRect.left) + Math.abs(br.top - editorRect.top));
    })[0] ?? null;
}

function describeComposerAddButtonCandidates() {
  const editor = findNormalFlowComposerEditor();
  const editorRect = editor?.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter(isVisible)
    .map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        ...describeElement(button),
        nearEditor: editorRect ? rect.top >= editorRect.top - 90 && rect.top <= editorRect.bottom + 120 : false,
        leftOfPrompt: editorRect ? rect.right <= editorRect.left + 100 : false
      };
    })
    .filter((item) => /add|upload|media|image|\+|add_2|create/i.test(item.text || item.aria || ""))
    .slice(-20);
}

function findComposerContainer() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return null;
  const editorRect = editor.getBoundingClientRect();
  let container: HTMLElement | null = editor;
  for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
    const rect = container.getBoundingClientRect();
    const hasPrompt = rect.left <= editorRect.left && rect.right >= editorRect.right;
    const composerSized = rect.height >= 40 && rect.height <= 460 && rect.width >= editorRect.width;
    const nearBottom = rect.top >= editorRect.top - 80 && rect.top <= editorRect.top + 20;
    if (hasPrompt && composerSized && nearBottom) return container;
  }
  return editor.parentElement;
}

function findNormalFlowComposerEditor() {
  return uniqueElements(safeQueryAll(flowSelectors.promptEditors.join(",")))
    .filter(isLikelyComposerEditor)
    .sort((a, b) => composerEditorScore(b) - composerEditorScore(a))[0] ?? null;
}

function findUntitledSessionPanel() {
  return [...document.querySelectorAll<HTMLElement>("[role='dialog'], aside, section, div")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 260 || rect.width > 620 || rect.height < 360) return false;
      if (rect.left < window.innerWidth * 0.45) return false;
      const label = normalizeOptionText(elementLabel(element));
      return label.includes("untitled session") && (
        label.includes("what would you like to do") ||
        label.includes("what do you want to create") ||
        label.includes("rename my assets") ||
        label.includes("turn a concept into prompts")
      );
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const rightBonus = rect.right > window.innerWidth - 40 ? 1000 : 0;
      const compactBonus = Math.max(0, 800 - Math.round(rect.width));
      return { element, score: rightBonus + compactBonus + domDepth(element) * 4 };
    })
    .sort((a, b) => b.score - a.score)[0]?.element ?? null;
}

function findUntitledSessionCloseButton(panel: HTMLElement) {
  const panelRect = panel.getBoundingClientRect();
  return [...panel.querySelectorAll<HTMLElement>("button, [role='button'], [aria-label]")]
    .filter((element) => {
      if (!isVisible(element) || isDisabled(element)) return false;
      const rect = element.getBoundingClientRect();
      const insidePanel = rect.left >= panelRect.left && rect.right <= panelRect.right && rect.top >= panelRect.top && rect.bottom <= panelRect.bottom;
      if (!insidePanel) return false;
      const label = normalizeOptionText(elementLabel(element));
      const isCloseLabel = /^(close|dismiss|cancel)$/.test(label) || /\b(close|dismiss)\b/.test(label);
      const isTopRightSmallButton = rect.width <= 56 && rect.height <= 56 && rect.right >= panelRect.right - 70 && rect.top <= panelRect.top + 70;
      return isCloseLabel || isTopRightSmallButton;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = normalizeOptionText(elementLabel(element));
      const closeLabelBonus = /\b(close|dismiss)\b/.test(label) ? 3000 : 0;
      const rightBonus = Math.max(0, Math.round(rect.right - panelRect.left));
      const topBonus = Math.max(0, 120 - Math.round(rect.top - panelRect.top));
      return { element, score: closeLabelBonus + rightBonus + topBonus };
    })
    .sort((a, b) => b.score - a.score)[0]?.element ?? null;
}

function isInsideUntitledSessionPanel(element: Element) {
  const panel = findUntitledSessionPanel();
  return Boolean(panel && panel.contains(element));
}

function findNewProjectButton() {
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], a, div")]
    .filter((element) => {
      if (!isVisible(element) || isDisabled(element) || isInsideUntitledSessionPanel(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 36) return false;
      const label = normalizeOptionText(elementLabel(element));
      return /\bnew project\b/.test(label);
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = normalizeOptionText(elementLabel(element));
      const exactBonus = label === "new project" || label === "+ new project" ? 2500 : 0;
      const roleBonus = /button/.test(element.getAttribute("role") || "") || element.tagName.toLowerCase() === "button" ? 900 : 0;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const centralBonus = centerX > window.innerWidth * 0.2 && centerX < window.innerWidth * 0.85 && centerY > 120 ? 500 : 0;
      const sizePenalty = rect.width > 420 || rect.height > 260 ? 500 : 0;
      return { element, score: exactBonus + roleBonus + centralBonus + optionScore(element) - sizePenalty };
    })
    .sort((a, b) => b.score - a.score)[0]?.element ?? null;
}

function countComposerAttachments() {
  const container = findComposerContainer();
  const elements = new Set<HTMLElement>();
  if (container) {
    for (const element of container.querySelectorAll<HTMLElement>("img, video, canvas, [data-testid*='image' i], [data-testid*='media' i], [aria-label*='image' i], [aria-label*='media' i]")) {
      elements.add(element);
    }
  }
  for (const element of findNearbyComposerAttachmentElements()) {
    elements.add(element);
  }
  for (const element of findComposerAttachmentControls().filter(composerAttachmentControlLooksReady)) {
    elements.add(element);
  }
  return [...elements]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 20 && rect.height >= 20;
    }).length;
}

function countComposerPendingAttachmentControls() {
  return findComposerAttachmentControls().length;
}

function findComposerAttachmentRemoveButton() {
  return findComposerAttachmentControls()
    .filter((element) => {
      const label = normalizeOptionText(elementLabel(element));
      return label.includes("cancel") || label.includes("remove") || label.includes("delete");
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.left - br.left || ar.top - br.top;
    })[0] ?? null;
}

function findComposerClearPromptButton() {
  const editor = findNormalFlowComposerEditor();
  const container = findComposerContainer();
  if (!editor || !container) return null;
  const editorRect = editor.getBoundingClientRect();
  return [...container.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((button) => {
      if (!isVisible(button) || isDisabled(button)) return false;
      const label = normalizeOptionText(elementLabel(button));
      if (!/clear prompt|clear|close/.test(label)) return false;
      const rect = button.getBoundingClientRect();
      return rect.top >= editorRect.top - 260 && rect.top <= editorRect.top + 60 && rect.left >= editorRect.right - 80;
    })
    .sort((a, b) => optionScore(b) - optionScore(a))[0] ?? null;
}

function findComposerAttachmentControls() {
  const editor = findNormalFlowComposerEditor();
  const editorRect = editor?.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((element) => {
      if (!isVisible(element) || isDisabled(element)) return false;
      const label = normalizeOptionText(elementLabel(element));
      const aria = normalizeOptionText(element.getAttribute("aria-label") || "");
      if (/add ingredients|prompt box/.test(label)) return false;
      const isIngredientChip =
        aria === "ingredient" ||
        /^ingredient\b/.test(label) ||
        /^(cancel|remove|delete)\s+ingredient\b/.test(label) ||
        (label.includes("ingredient") && /cancel|remove|delete/.test(label));
      if (!isIngredientChip) return false;
      if (!editorRect) return true;
      const rect = element.getBoundingClientRect();
      const nearAttachmentRow =
        rect.top >= editorRect.top - 220 &&
        rect.top <= editorRect.bottom + 80 &&
        rect.left >= editorRect.left - 80 &&
        rect.left <= editorRect.left + 340;
      return nearAttachmentRow;
    });
}

function composerAttachmentControlLooksReady(element: HTMLElement) {
  const label = normalizeOptionText(elementLabel(element));
  const aria = normalizeOptionText(element.getAttribute("aria-label") || "");
  if (aria !== "ingredient" && !label.includes("ingredient")) return false;
  if (/cancel|remove|delete|close/.test(label)) return true;
  return Boolean(element.querySelector("img, video, canvas"));
}

function findNearbyComposerAttachmentElements() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return [];
  const editorRect = editor.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("img, video, canvas")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.width > 180 || rect.height > 180) return false;
      const nearComposerX = rect.left >= editorRect.left - 30 && rect.left <= editorRect.left + 220;
      const aboveOrInsideComposer = rect.bottom >= editorRect.top - 140 && rect.top <= editorRect.bottom + 30;
      return nearComposerX && aboveOrInsideComposer;
    });
}

function createButtonHasMediaReady() {
  const submit = findComposerSubmitButton();
  return Boolean(submit && !isDisabled(submit));
}

function describeComposer() {
  const container = findComposerContainer();
  return container ? {
    container: describeElement(container),
    attachments: countComposerAttachments(),
    buttons: [...container.querySelectorAll<HTMLElement>("button, [role='button']")].filter(isVisible).map(describeElement).slice(0, 12),
    inputs: [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].map(describeElement).slice(0, 8)
  } : null;
}

function findComposerAgentButton() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return null;
  const editorRect = editor.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((button) => {
      if (!isVisible(button) || isDisabled(button)) return false;
      const rect = button.getBoundingClientRect();
      const label = normalizeOptionText(elementLabel(button));
      const nearComposer =
        rect.top >= editorRect.top - 100 &&
        rect.top <= editorRect.bottom + 140 &&
        rect.left >= editorRect.left - 120 &&
        rect.right <= editorRect.right + 220;
      return nearComposer && /^agent$/.test(label);
    })
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    })[0] ?? null;
}

function isAgentButtonActive(button: HTMLElement) {
  const pressed = button.getAttribute("aria-pressed");
  const selected = button.getAttribute("aria-selected");
  const checked = button.getAttribute("aria-checked");
  const state = button.getAttribute("data-state");
  if (pressed === "true" || selected === "true" || checked === "true" || state === "checked" || state === "active") {
    return true;
  }
  if (pressed === "false" || selected === "false" || checked === "false" || state === "unchecked" || state === "inactive") {
    return false;
  }

  const styles = getComputedStyle(button);
  const bg = parseCssRgb(styles.backgroundColor);
  const color = parseCssRgb(styles.color);
  if (!bg) return false;
  const backgroundLuminance = colorLuminance(bg);
  const textLuminance = color ? colorLuminance(color) : 255;
  return backgroundLuminance > 150 && textLuminance < 120;
}

function parseCssRgb(value: string) {
  const match = value.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d?(?:\.\d+)?))?\)/i);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha < 0.2) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function colorLuminance([r, g, b]: readonly [number, number, number]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function findComposerConfigButton() {
  const editor = findNormalFlowComposerEditor();
  if (!editor) return findFallbackComposerConfigButton();
  const editorRect = editor.getBoundingClientRect();
  const candidates = [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter((button) => {
      if (!isVisible(button)) return false;
      const rect = button.getBoundingClientRect();
      const label = elementLabel(button);
      if (rect.width > 380 || rect.height > 96 || looksLikeGenerationCard(button, rect, label)) return false;
      const looksLikeConfig = /aspect|model|banana|veo|imagen|omni|flash|crop_|16:9|9:16|x\d|image|video/i.test(label);
      const nearComposer =
        rect.top >= editorRect.top - 260 &&
        rect.top <= editorRect.bottom + 80 &&
        rect.left >= editorRect.left - 80 &&
        rect.left <= editorRect.right + 280;
      const notSubmit = !/arrow_forward|create|generate|submit/i.test(label);
      return looksLikeConfig && nearComposer && notSubmit;
    })
    .map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        button,
        score: rect.left + rect.top + (/banana|veo|imagen|omni|flash/i.test(elementLabel(button)) ? 800 : 0)
      };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.button ?? findFallbackComposerConfigButton();
}

function findFallbackComposerConfigButton() {
  return composerControlCandidates()
    .filter(({ element, label, rect }) => {
      if (rect.width > 380 || rect.height > 96 || looksLikeGenerationCard(element, rect, label)) return false;
      const looksLikeConfig = /settings trigger|aspect|model|banana|veo|imagen|omni|flash|crop_|16:9|9:16|x\d|image|video/i.test(label);
      const notSubmit = !/arrow_forward|create|generate|submit|start generation/i.test(label);
      return looksLikeConfig && notSubmit;
    })
    .sort((a, b) => composerControlScore(b.element) - composerControlScore(a.element))[0]?.element ?? null;
}

function findFallbackComposerSubmitButton() {
  return composerControlCandidates()
    .filter(({ element, label, rect }) => {
      if (rect.width > 96 || rect.height > 96 || looksLikeGenerationCard(element, rect, label)) return false;
      return /arrow_forward|start generation|generate|submit/i.test(label);
    })
    .sort((a, b) => composerControlScore(b.element) - composerControlScore(a.element))[0]?.element ?? null;
}

function composerControlCandidates() {
  return [...document.querySelectorAll<HTMLElement>("button, [role='button'], img")]
    .filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (!isNearBottomComposerArea(rect)) return false;
      const label = elementLabel(element);
      if (!label) return false;
      return /settings trigger|banana|veo|imagen|omni|flash|crop_|16:9|9:16|x\d|image|video|arrow_forward|start generation|generate|submit/i.test(label);
    })
    .map((element) => ({ element, label: elementLabel(element), rect: element.getBoundingClientRect() }));
}

function isNearBottomComposerArea(rect: DOMRect) {
  const bottomBandTop = Math.max(0, window.innerHeight - 360);
  const notTopNavigation = rect.top > 120;
  const inBottomBand = rect.top >= bottomBandTop || rect.bottom >= window.innerHeight - 180;
  const horizontallyUseful = rect.left >= 0 && rect.right <= window.innerWidth;
  return notTopNavigation && inBottomBand && horizontallyUseful;
}

function composerControlScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const label = elementLabel(element);
  return rect.top + rect.left + (/settings trigger|arrow_forward|start generation/i.test(label) ? 1000 : 0);
}

function looksLikeGenerationCard(element: HTMLElement, rect = element.getBoundingClientRect(), label = elementLabel(element)) {
  if (element.hasAttribute("data-tile-id") || generatedCardIds.has(element)) return true;
  const normalized = normalizeOptionText(label);
  const cardSized = rect.width >= 280 && rect.height >= 160;
  const mediaCardText = /^(image|video)/.test(normalized) || /play_circle|reuse prompt|delete|download|retry|failedthis generation/.test(normalized);
  return cardSized && mediaCardText;
}

function inferDisabledCreateReason() {
  const editor = findNormalFlowComposerEditor();
  const promptText = editor ? editorText(editor).trim() : "";
  const visibleText = document.body.textContent || "";
  if (!promptText || /what do you want to create/i.test(promptText)) return "Prompt is empty.";
  if (/drop media|add media|image/i.test(visibleText) && !document.querySelector("img[src], video[src]")) {
    return "The selected Flow mode likely requires media, but no image/video is attached.";
  }
  return "Flow has not enabled Create yet. Check selected mode, credits, required media, or model settings.";
}

function safeQuery(selector: string) {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function safeQueryAll(selector: string) {
  try {
    return [...document.querySelectorAll<HTMLElement>(selector)];
  } catch {
    return [];
  }
}

function deepQueryAll<T extends Element = HTMLElement>(selector: string, root: ParentNode = document) {
  const results: T[] = [];
  const seen = new Set<Element>();
  const visit = (scope: ParentNode) => {
    let matches: T[] = [];
    let descendants: Element[] = [];
    try {
      matches = [...scope.querySelectorAll<T>(selector)];
      descendants = [...scope.querySelectorAll<Element>("*")];
    } catch {
      return;
    }
    for (const element of matches) {
      if (seen.has(element)) continue;
      seen.add(element);
      results.push(element);
    }
    for (const element of descendants) {
      if (element instanceof HTMLElement && element.shadowRoot) visit(element.shadowRoot);
    }
    if (scope instanceof HTMLElement && scope.shadowRoot) visit(scope.shadowRoot);
  };

  if (root instanceof Element && root.matches(selector) && !seen.has(root)) {
    seen.add(root);
    results.push(root as T);
  }
  visit(root);
  return results;
}

function parentElementOrHost(element: HTMLElement) {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}

function isVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

function isInViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;
}

function focusElementWithoutScrolling(element: HTMLElement) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Avoid fallback focus because it can scroll Flow back down to the composer.
  }
}

function isDisabled(element: Element) {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function elementLabel(element: Element) {
  return `${element.textContent || ""} ${element.getAttribute("placeholder") || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("alt") || ""}`.trim();
}

function isFlowPage() {
  return location.hostname === "flow.google.com" || (location.hostname === "labs.google" && location.href.includes("flow"));
}

function isFlowProjectPage() {
  return location.hostname === "flow.google.com" && /^\/project\/[^/]+/.test(location.pathname);
}

function isLikelyComposerEditor(element: HTMLElement) {
  if (!isVisible(element) || isDisabled(element) || isInsideUntitledSessionPanel(element)) return false;
  if (element.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
  const tagName = element.tagName.toLowerCase();
  const role = normalizeOptionText(element.getAttribute("role") || "");
  const inputType = normalizeOptionText((element as HTMLInputElement).type || "");
  if (tagName === "input" && inputType && !["text", "search"].includes(inputType)) return false;
  const editable = isTextInputEditor(element) || element.isContentEditable || role === "textbox";
  if (!editable) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 160 || rect.height < 12) return false;
  const label = normalizeOptionText(elementLabel(element));
  if (/search|filter|rename|title|file name|folder/.test(label)) return false;
  const promptLike = /what do you want to create|prompt|describe|create/.test(label);
  const nearComposerBottom = rect.top > window.innerHeight * 0.45;
  return promptLike || nearComposerBottom;
}

function composerEditorScore(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const label = normalizeOptionText(elementLabel(element));
  const promptBonus = /what do you want to create|prompt|describe|create/.test(label) ? 3000 : 0;
  const editableBonus = element.isContentEditable ? 500 : 0;
  const inputBonus = isTextInputEditor(element) ? 300 : 0;
  const bottomBonus = Math.round(rect.top);
  return promptBonus + editableBonus + inputBonus + bottomBonus + Math.min(rect.width, 900);
}

function isTextInputEditor(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function editorText(editor: HTMLElement) {
  if (isTextInputEditor(editor)) return editor.value;
  return editor.textContent || "";
}

function setEditorText(editor: HTMLElement, value: string) {
  if (isTextInputEditor(editor)) {
    editor.value = value;
  } else {
    editor.textContent = value;
  }
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function uniqueElements<T extends Element>(elements: T[]) {
  return [...new Set(elements)];
}

async function waitUntil<T>(callback: () => T | null | false, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = callback();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(
  level: FlowLogEntry["level"],
  message: string,
  details?: unknown,
  groupId?: string,
  promptIndex?: number
) {
  const entry: FlowLogEntry = {
    id: `content-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    level,
    source: "content",
    message,
    groupId,
    promptIndex,
    details
  };
  sendRuntimeMessage({ type: "LOG_EVENT", entry }).catch(() => undefined);
}

function collectDiagnostics() {
  const editor = findNormalFlowComposerEditor();
  const buttons = [...document.querySelectorAll<HTMLElement>("button, [role='button']")]
    .filter(isVisible)
    .slice(-30)
    .map(describeElement);
  const submit = findComposerSubmitButton();
  const config = findComposerConfigButton();
  return {
    href: location.href,
    title: document.title,
    isFlowPage: isFlowPage(),
    editor: editor ? describeElement(editor) : null,
    composerSubmit: submit ? describeElement(submit) : null,
    composerConfig: config ? describeElement(config) : null,
    bodyTail: (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(-600),
    tileIds: collectTileIds(),
    visibleButtons: buttons
  };
}

function describeElement(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    aria: element.getAttribute("aria-label"),
    text: (element.textContent || "").trim().slice(0, 120),
    disabled: isDisabled(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function errorToText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function preparedImageToPngFile(image: PreparedImage) {
  const blob = dataUrlToBlob(image);
  const mimeType = (blob.type || image.mimeType || "").toLowerCase();
  if (mimeType === "image/png") {
    return new File([blob], ensureImageExtension(image.name, "png"), { type: "image/png" });
  }

  const pngBlob = await imageBlobToPng(blob);
  return new File([pngBlob], ensureImageExtension(image.name, "png"), { type: "image/png" });
}

async function imageBlobToPng(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare image canvas.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error("Could not convert image to PNG."));
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
}

function ensureImageExtension(name: string, extension: string) {
  const safeExtension = extension.replace(/^\./, "");
  return name.replace(/\.[^.]+$/, "") + `.${safeExtension}`;
}

function dataUrlToBlob(image: PreparedImage) {
  const [header, payload] = image.dataUrl.split(",");
  const mimeType = header.match(/data:([^;]+)/)?.[1] || image.mimeType || "application/octet-stream";
  const bytes = Uint8Array.from(atob(payload || ""), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "flow-output";
}

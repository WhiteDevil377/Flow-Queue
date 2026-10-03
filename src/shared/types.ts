export type PromptMode =
  | "text-to-video"
  | "image-to-video"
  | "text-to-image"
  | "image-to-image";

export type PromptStatus = "pending" | "running" | "generating" | "downloading" | "completed" | "error" | "cancelled";
export type PromptGroupStatus = "queued" | "running" | "completed" | "error" | "cancelled";
export type DownloadQuality = "no-download" | "direct" | "1080" | "2k" | "4k";

export interface PreparedImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface PromptPayload {
  id: string;
  prompt: string;
  mode: PromptMode;
  imageIds?: string[];
  characterName?: string;
  speakerName?: string;
  aspectRatio: string;
  model: string;
  imageModel: string;
  outputCount: number;
  videoDuration: string;
  autoDownloadResourceQuality: DownloadQuality;
  autoChangeFileName: boolean;
  folderName: string;
  filePrefix: string;
  maxRetries: number;
  originalIndex?: number;
  outputPreviousPrompt?: {
    tileIds?: string[];
    nextPromptEditImage?: boolean;
    extractedFrame?: string;
  };
}

export interface PromptResult {
  id: string;
  index: number;
  prompt: string;
  status: PromptStatus;
  percentage: number;
  error?: string;
  tileIds?: string[];
  downloaded?: number;
  payload?: PromptPayload;
}

export interface PromptGroup {
  id: string;
  status: PromptGroupStatus;
  createdAt: number;
  totalCount: number;
  processedCount: number;
  currentIndex?: number;
  results: PromptResult[];
  isCancelling?: boolean;
}

export interface FlowLogEntry {
  id: string;
  at: number;
  level: "debug" | "info" | "warn" | "error";
  source: "sidepanel" | "content" | "background";
  message: string;
  groupId?: string;
  promptIndex?: number;
  details?: unknown;
}

export interface VideoResourceCandidate {
  url: string;
  at: number;
  source: "network-request" | "network-response" | "network-body";
  mimeType?: string;
  resourceType?: string;
  context?: string;
}

export interface DownloadSettings {
  folderName: string;
  filePrefix: string;
  autoDownload: boolean;
  autoChangeFileName: boolean;
  videoQuality: DownloadQuality;
  imageQuality: DownloadQuality;
}

export interface AutomationSettings {
  defaultMode: PromptMode;
  concurrentPrompts: number;
  promptDelaySecondsMin: number;
  promptDelaySecondsMax: number;
  maxRetries: number;
  aspectRatio: string;
  model: string;
  imageModel: string;
  outputCount: number;
  videoDuration: string;
  imageToVideoMaxImages: number;
  imageToImageMaxImages: number;
  download: DownloadSettings;
}

export interface FlowSelectors {
  createProjectButtons: string[];
  modeConfigButtons: string[];
  videoConfigButtons: string[];
  imageConfigButtons: string[];
  promptEditors: string[];
  submitButtons: string[];
  fileInputs: string[];
  outputTiles: string[];
  tileById: (tileId: string) => string;
  editLinkById: (tileId: string) => string;
  tileProgress: string[];
  hoverMenuButtons: string[];
  downloadButtons: string[];
  doneButtons: string[];
  profileButtons: string[];
  closeDialogButtons: string[];
  characterTabButtons: string[];
  characterNameItems: string[];
  searchInputs: string[];
}

export interface StartPromptGroupRequest {
  type: "START_PROMPT_GROUP";
  groupId: string;
  payloads: PromptPayload[];
  concurrentPrompts: number;
  promptDelaySecondsMin: number;
  promptDelaySecondsMax: number;
}

export type RuntimeRequest =
  | { type: "GET_FLOW_SELECTORS" }
  | { type: "CHECK_FLOW_PAGE" }
  | StartPromptGroupRequest
  | { type: "CANCEL_PROMPT_GROUP"; groupId: string }
  | { type: "PREPARE_IMAGE"; id: string; image: PreparedImage }
  | { type: "PREPARE_IMAGE_CHUNK"; id: string; chunk: string; chunkIndex: number; totalChunks: number }
  | { type: "SCAN_CHARACTERS" }
  | { type: "SET_ZOOM"; zoomFactor: number }
  | { type: "START_DOWNLOAD"; url: string; filename?: string; folder?: string; filePrefix?: string; autoChangeFileName?: boolean }
  | { type: "SET_DOWNLOAD_NAMING"; folderName?: string; filePrefix?: string; autoChangeFileName?: boolean }
  | { type: "REGISTER_EXPECTED_FLOW_DOWNLOAD"; expectationId: string; filename?: string; folder?: string; filePrefix?: string; autoChangeFileName?: boolean }
  | { type: "WAIT_EXPECTED_FLOW_DOWNLOAD"; expectationId: string; timeoutMs?: number }
  | { type: "CLEAR_EXPECTED_FLOW_DOWNLOAD"; expectationId: string }
  | { type: "CLEAR_FLOW_SESSION" }
  | { type: "GET_RECENT_VIDEO_URLS"; sinceMs?: number }
  | { type: "ATTACH_DEBUGGER" }
  | { type: "DETACH_DEBUGGER" }
  | { type: "INSERT_TEXT"; text: string }
  | { type: "SEND_KEY"; key: string; code: string; keyCode: number; modifiers?: number }
  | { type: "MOVE_MOUSE"; x: number; y: number }
  | { type: "CLICK_AT"; x: number; y: number }
  | { type: "PROMPT_GROUP_UPDATE"; group: PromptGroup }
  | { type: "LOG_EVENT"; entry: FlowLogEntry }
  | { type: "GET_LOGS" }
  | { type: "CLEAR_LOGS" };

export type RuntimeResponse<T = unknown> =
  | ({ success: true } & T)
  | ({ success: false; error: string; cancelled?: boolean } & Partial<T>);

export const DEFAULT_SETTINGS: AutomationSettings = {
  defaultMode: "text-to-video",
  concurrentPrompts: 1,
  promptDelaySecondsMin: 20,
  promptDelaySecondsMax: 30,
  maxRetries: 3,
  aspectRatio: "16:9",
  model: "Omni 1.1 Flash",
  imageModel: "Nano Banana 2",
  outputCount: 1,
  videoDuration: "8s",
  imageToVideoMaxImages: 3,
  imageToImageMaxImages: 3,
  download: {
    folderName: "Flow Queue",
    filePrefix: "",
    autoDownload: true,
    autoChangeFileName: true,
    videoQuality: "direct",
    imageQuality: "direct"
  }
};

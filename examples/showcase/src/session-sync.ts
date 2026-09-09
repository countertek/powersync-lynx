export interface SessionSyncStatus {
  connected?: boolean;
  connecting?: boolean;
  hasSynced?: boolean;
  lastSyncedAt?: Date;
  downloading?: boolean;
  uploading?: boolean;
  downloadError?: Error;
  uploadError?: Error;
  dataFlowStatus?: {
    downloading?: boolean;
    uploading?: boolean;
    downloadError?: Error;
    uploadError?: Error;
  };
}

export interface SessionSyncUi {
  log(message: string): void;
  setSyncLabel(label: string): void;
  setHasSyncedLabel(label: string): void;
  setLastSyncedText(text: string): void;
  setFirstSyncDone(done: boolean): void;
}

export interface SessionSyncTracker {
  statusChanged(status: SessionSyncStatus): void;
  watchFirstSync(waitForFirstSync: () => Promise<void>, isCancelled: () => boolean): void;
}

export function lastSyncedLabel(at: Date | undefined): string {
  if (at == null) {
    return "never";
  }
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    return "never";
  }
  return at.toISOString();
}

export function lastSyncedMs(at: Date | undefined): number | undefined {
  if (at == null) {
    return undefined;
  }
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return ms;
}

/** This-session checkpoint: lastSyncedAt must advance past the value seen at first status. */
export function checkpointAppliedThisSession(
  lastMs: number | undefined,
  baselineLastSyncedMs: number | undefined,
): boolean {
  return lastMs != null && lastMs !== baselineLastSyncedMs;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function createSessionSyncTracker(ui: SessionSyncUi): SessionSyncTracker {
  let loggedConnected = false;
  let loggedCheckpoint = false;
  let capturedBaseline = false;
  let baselineLastSyncedMs: number | undefined;
  let loggedFirstSync = false;

  return {
    statusChanged(status) {
      const connected = status.connected === true;
      const uploading = status.uploading === true || status.dataFlowStatus?.uploading === true;
      const downloading =
        status.downloading === true || status.dataFlowStatus?.downloading === true;
      const lastMs = lastSyncedMs(status.lastSyncedAt);
      if (!capturedBaseline) {
        capturedBaseline = true;
        baselineLastSyncedMs = lastMs;
      }
      ui.setHasSyncedLabel(status.hasSynced === true ? "yes" : "no");
      ui.setLastSyncedText(lastSyncedLabel(status.lastSyncedAt));
      if (status.connecting === true) {
        ui.setSyncLabel("connecting");
      } else {
        ui.setSyncLabel(connected ? "connected" : "offline");
      }
      if (connected && !loggedConnected) {
        loggedConnected = true;
        ui.log("connected");
      }
      if (uploading) {
        ui.log("upload in progress");
      }
      if (downloading) {
        ui.log("download in progress");
      }
      if (!loggedCheckpoint && checkpointAppliedThisSession(lastMs, baselineLastSyncedMs)) {
        loggedCheckpoint = true;
        ui.log("first checkpoint applied");
      }
      const downloadError = status.downloadError ?? status.dataFlowStatus?.downloadError;
      const uploadError = status.uploadError ?? status.dataFlowStatus?.uploadError;
      if (downloadError != null) {
        ui.log(`sync error: ${errorMessage(downloadError)}`);
      }
      if (uploadError != null) {
        ui.log(`upload error: ${errorMessage(uploadError)}`);
      }
    },
    watchFirstSync(waitForFirstSync, isCancelled) {
      void waitForFirstSync()
        .then(() => {
          if (isCancelled() || loggedFirstSync) {
            return;
          }
          loggedFirstSync = true;
          ui.setFirstSyncDone(true);
          ui.log("first sync done");
        })
        .catch((err: unknown) => {
          ui.log(`waitForFirstSync: ${errorMessage(err)}`);
        });
    },
  };
}

import { useCallback, useEffect, useState } from 'react';
import type { ExtensionUiRequest, ExtensionUiResponse } from '../../shared/types.js';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';

export interface UiToast {
  id: string;
  message: string;
  notifyType: 'info' | 'warning' | 'error';
}

export interface UiStatusBar {
  key: string;
  text: string;
}

export interface UiWidget {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor' | 'above';
}

export interface ExtensionUiState {
  /** Pending dialog requests (select/confirm/input/editor). */
  dialogs: ExtensionUiRequest[];
  toasts: UiToast[];
  statusBar: UiStatusBar | null;
  widgets: UiWidget[];
  respond: (response: ExtensionUiResponse) => Promise<void>;
}

const POLL_MS = 1500;
const TOAST_MS = 3500;

const DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'];

/**
 * Extension UI protocol (P1-01): polls the backend for pending dialog
 * requests and listens on SSE for fire-and-forget frames (notify/setStatus/
 * setWidget/setTitle/set_editor_text). Answers go back via POST ui-respond.
 */
export function useExtensionUi(): ExtensionUiState {
  const [dialogs, setDialogs] = useState<ExtensionUiRequest[]>([]);
  const [toasts, setToasts] = useState<UiToast[]>([]);
  const [statusBar, setStatusBar] = useState<UiStatusBar | null>(null);
  const [widgets, setWidgets] = useState<UiWidget[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Fire-and-forget frames arrive over SSE (they are not held pending).
  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const onFrame = (event: Event): void => {
      let frame: ExtensionUiRequest;
      try {
        frame = JSON.parse((event as MessageEvent<string>).data) as ExtensionUiRequest;
      } catch {
        return;
      }
      if (DIALOG_METHODS.includes(frame.method)) {
        return;
      }
      handleFireAndForget(frame);
    };
    source.addEventListener('pi', onFrame);
    return () => {
      source.removeEventListener('pi', onFrame);
      source.close();
    };
  }, []);

  const handleFireAndForget = (request: ExtensionUiRequest): void => {
    if (request.method === 'notify') {
      const id = request.id;
      setToasts((prev) => [
        ...prev,
        { id, message: request.message, notifyType: request.notifyType ?? 'info' },
      ]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, TOAST_MS);
    } else if (request.method === 'setStatus') {
      setStatusBar(
        request.statusText === undefined || request.statusText === ''
          ? null
          : { key: request.statusKey, text: request.statusText },
      );
    } else if (request.method === 'setWidget') {
      const lines = request.widgetLines;
      if (lines === undefined) {
        setWidgets((prev) => prev.filter((widget) => widget.key !== request.widgetKey));
      } else {
        setWidgets((prev) => {
          const rest = prev.filter((widget) => widget.key !== request.widgetKey);
          return [
            ...rest,
            {
              key: request.widgetKey,
              lines,
              placement: request.widgetPlacement ?? 'above',
            },
          ];
        });
      }
    } else if (request.method === 'setTitle') {
      document.title = `${request.title} — PiHub`;
    } else if (request.method === 'set_editor_text') {
      setDialogs((prev) => {
        const editorDialog = prev.find(
          (dialog) => dialog.id === request.id && dialog.method === 'editor',
        ) as Extract<ExtensionUiRequest, { method: 'editor' }> | undefined;
        if (editorDialog === undefined) {
          return prev;
        }
        const index = prev.indexOf(editorDialog);
        if (index === -1) {
          return prev;
        }
        const next = prev.slice();
        next[index] = {
          type: 'extension_ui_request',
          id: editorDialog.id,
          method: 'editor',
          title: editorDialog.title,
          prefill: request.text,
        };
        return next;
      });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      let requests: ExtensionUiRequest[] = [];
      try {
        const result = await api.uiRequests();
        requests = result.requests;
      } catch {
        // backend offline; retry on next tick
      }
      if (cancelled) {
        return;
      }
      setDialogs((prev) => {
        // Keep only still-pending dialogs plus any new ones.
        const byId = new Map(requests.filter((r) => DIALOG_METHODS.includes(r.method)).map((r) => [r.id, r]));
        const next = prev.filter((dialog) => byId.has(dialog.id));
        for (const request of requests) {
          if (!DIALOG_METHODS.includes(request.method)) {
            continue;
          }
          if (byId.has(request.id) && !prev.some((dialog) => dialog.id === request.id)) {
            next.push(request);
          }
        }
        return next;
      });
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reloadKey]);

  const respond = useCallback(async (response: ExtensionUiResponse): Promise<void> => {
    setDialogs((prev) => prev.filter((dialog) => dialog.id !== response.id));
    try {
      await api.respondUi(response);
    } catch {
      // backend offline; the dialog is dropped locally anyway
    }
    setReloadKey((prev) => prev + 1);
  }, []);

  return { dialogs, toasts, statusBar, widgets, respond };
}

import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, SpeakerLogApi } from '../shared/types';

const api: SpeakerLogApi = {
  onEvent(cb: (event: AppEvent) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, event: AppEvent) => cb(event);
    ipcRenderer.on('app-event', listener);
    return () => ipcRenderer.removeListener('app-event', listener);
  },
};

contextBridge.exposeInMainWorld('speakerLog', api);

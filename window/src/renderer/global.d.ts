import type { SpeakerLogApi } from '../shared/types';

declare global {
  interface Window {
    speakerLog: SpeakerLogApi;
  }
}

export {};

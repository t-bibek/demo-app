import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Appends the Recall-style event stream to an NDJSON log file (one JSON object
 * per line): `meeting_initialized` / `meeting_updated` / `meeting_ended`,
 * `participant_joined` / `participant_updated` / `participant_left`, and
 * `speech_on` / `speech_off`.
 *
 * The macOS port writes the same file (`sessions.ndjson`) via
 * `NdjsonSessionLogger`; this is the Windows equivalent. Best-effort: a failure
 * to open/write the file never throws into the detection pipeline.
 */
export class EventLogWriter {
  readonly filePath: string;
  private stream: fs.WriteStream | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), 'sessions.ndjson');
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  /** Append one event line `{"type": ..., ...fields, "ts": ...}`. */
  logEvent(type: string, fields: Record<string, unknown>, ts: number): void {
    if (!this.stream) return;
    const obj = { ...fields, type, ts };
    try {
      this.stream.write(`${JSON.stringify(obj)}\n`);
    } catch {
      this.stream = null;
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

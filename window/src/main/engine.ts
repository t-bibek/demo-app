import { spawn, ChildProcessByStdio } from 'child_process';
import { app } from 'electron';
import path from 'path';
import type { Readable } from 'stream';
import { NdjsonParser } from '../shared/ndjson';
import { EngineEvent } from '../shared/types';

export interface EngineHandlers {
  onEvent: (event: EngineEvent) => void;
  onExit: (code: number | null) => void;
}

const MAX_RESTARTS = 5;
/** A child that survived this long is considered healthy: reset the budget. */
const HEALTHY_RUN_MS = 60_000;

/**
 * Spawns and supervises the UIA engine: a PowerShell-hosted C# process that
 * polls the UI Automation trees of meeting windows and emits NDJSON events.
 */
export class UiaEngine {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private spawnedAt = 0;

  constructor(
    private readonly handlers: EngineHandlers,
    private readonly options: { simulate?: boolean; pollMs?: number } = {},
  ) {}

  get scriptPath(): string {
    return path.join(app.getAppPath(), 'engine', 'uia-engine.ps1');
  }

  /**
   * Windows PowerShell 5.1 ships with Windows 10/11 and carries the
   * UIAutomationClient assemblies. Resolved absolutely — PATH can be
   * stripped in locked-down environments.
   */
  get powershellPath(): string {
    return path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
  }

  start(): void {
    if (this.child || this.stopped) return;

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath,
    ];
    if (this.options.simulate) args.push('-Simulate');
    if (this.options.pollMs) args.push('-PollMs', String(this.options.pollMs));

    const child = spawn(this.powershellPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.spawnedAt = Date.now();

    const parser = new NdjsonParser<EngineEvent>(
      (event) => this.handlers.onEvent(event),
      (line) => {
        this.status('warn', `Unparseable engine output: ${line.slice(0, 300)}`);
      },
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => parser.push(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      if (/running scripts is disabled|execution of scripts is disabled/i.test(text)) {
        this.status(
          'error',
          'PowerShell script execution is disabled by Group Policy on this machine, so the UIA ' +
            'engine cannot run. Ask IT to allow script execution for this app.',
        );
      }
      this.status('error', `engine stderr: ${text.slice(0, 1000)}`);
    });

    // 'close' (not 'exit'): it fires after stdio has fully drained AND also
    // after spawn failures (which emit 'error'+'close' but never 'exit').
    child.on('close', (code) => {
      parser.flush();
      this.child = null;
      this.handlers.onExit(code);
      if (this.stopped) return;

      if (Date.now() - this.spawnedAt >= HEALTHY_RUN_MS) {
        this.restartCount = 0; // crashes hours apart should not exhaust the budget
      }
      if (this.restartCount < MAX_RESTARTS) {
        this.restartCount += 1;
        this.status(
          'warn',
          `Engine exited with code ${code}; restarting (attempt ${this.restartCount}/${MAX_RESTARTS})...`,
        );
        this.restartTimer = setTimeout(() => this.start(), 2000);
      } else {
        this.status(
          'error',
          `Engine crashed ${MAX_RESTARTS} times in a row and will not be restarted — speaker ` +
            'detection is OFF. Restart the app to try again.',
        );
      }
    });

    child.on('error', (error) => {
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? ` (powershell.exe not found at ${this.powershellPath})`
        : '';
      this.status('error', `Failed to spawn PowerShell engine: ${String(error)}${hint}`);
      // No 'exit' fires after a spawn failure; 'close' still does, and the
      // restart/cleanup logic above runs there.
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  private status(level: 'info' | 'warn' | 'error', message: string): void {
    this.handlers.onEvent({ type: 'status', level, message, ts: Date.now() });
  }
}

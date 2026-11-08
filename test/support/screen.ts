// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What is actually ON SCREEN in a real webview, read from inside the extension host (T-15).
 *
 * `panel.webview.html` is the markup the host handed over, not the page a person is looking at.
 * Everything a press changes — a note, a disabled button, focus — is changed by the page's own
 * client script, after that markup was set, and VS Code gives an extension no way to read it
 * back. So a vscode-test that inspects `webview.html` after a press sees exactly what it saw
 * before the press, whatever the page did: the test is blind in precisely the way the owner was
 * NOT when he pressed *Build the plan* and watched nothing happen. T-15 exists because eleven
 * machine reviews looked at markup and one person looked at the screen.
 *
 * How it reads the screen: `.vscode-test.mjs` launches the test host with
 * `--remote-debugging-port=0` — a port the OS picks, bound to 127.0.0.1, gone when the test host
 * exits. Chromium writes that port into `DevToolsActivePort` in the host's user-data directory,
 * which is three levels above `globalStorageUri`. This module speaks the DevTools protocol over
 * the `WebSocket` Node ships, finds the webview's frame by its `<title>`, and evaluates in an
 * ISOLATED WORLD of that frame: it shares the page's DOM (so it reads what is rendered and its
 * clicks reach the page's own listeners) but none of its script globals (so a test can never
 * call the page's functions directly and pass by going around them).
 *
 * Test-only. Nothing under `test/` ships (`.vscodeignore`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type * as vscode from 'vscode';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** A frame inside a webview: the DevTools session that reaches it, and an isolated world in it. */
export interface Frame {
  sessionId: string;
  contextId: number;
  /** The DevTools target (one per webview iframe). A test that disposes a panel passes its frame's
   *  target to `webview(…, exclude)` so a lingering, torn-down frame is never read as the new one. */
  targetId?: string;
}

/**
 * A distinct failure for "the screen could not be read at all", so a test can never mistake a
 * reader that never connected for a page that showed nothing (`empty-is-not-absence.md`).
 */
export class ScreenUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenUnreadable';
  }
}

export class Screen {
  private next = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, string>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return; // an event; nothing here subscribes to any
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message));
      else waiting.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const waiting of this.pending.values()) waiting.reject(new ScreenUnreadable('the DevTools connection closed'));
      this.pending.clear();
    };
  }

  /** Connects to the test host's own DevTools endpoint. Throws `ScreenUnreadable`, never returns a dud. */
  static async open(context: vscode.ExtensionContext): Promise<Screen> {
    const userData = path.resolve(context.globalStorageUri.fsPath, '..', '..', '..');
    const portFile = path.join(userData, 'DevToolsActivePort');
    let lines: string[];
    try {
      lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    } catch {
      throw new ScreenUnreadable(
        `no ${portFile}: the test host was not launched with --remote-debugging-port (see .vscode-test.mjs), `
        + 'so nothing on screen can be read',
      );
    }
    const [port, browserPath] = lines;
    if (!port || !browserPath || !/^\d+$/.test(port)) throw new ScreenUnreadable(`unreadable ${portFile}: ${JSON.stringify(lines)}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new ScreenUnreadable(`could not connect to the DevTools port ${port} named in ${portFile}`));
    });
    return new Screen(ws);
  }

  close(): void {
    this.ws.close();
  }

  private send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      // A command sent into a frame that is being torn down can go unanswered for good. Without a
      // deadline that is a test hanging until mocha's own timeout, which says nothing about why;
      // with one it is a failure that names the command — and `stale`-shaped, so a reader retries.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new ScreenUnreadable(`no answer to ${method} within 10 s — Session with given id not found (presumed)`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); (resolve as (value: unknown) => void)(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  private async session(targetId: string): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    return sessionId;
  }

  /**
   * The frame of the webview whose `<title>` is `title`, polling until it exists. A re-render
   * (`webview.html = …`) replaces the frame, so call this again after one rather than reusing
   * an old `Frame`.
   */
  async webview(title: string, timeoutMs = 15_000, exclude: ReadonlySet<string> = new Set()): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
      for (const target of targetInfos) {
        if (target.type !== 'iframe' || !target.url.startsWith('vscode-webview://') || exclude.has(target.targetId)) continue;
        let sessionId: string;
        try {
          sessionId = await this.session(target.targetId);
        } catch {
          continue; // the frame went away between listing and attaching — look again
        }
        const tree = await this.send<{ frameTree: FrameNode }>('Page.getFrameTree', {}, sessionId).catch(() => undefined);
        if (!tree) continue;
        for (const frame of flatten(tree.frameTree)) {
          const world = await this.send<{ executionContextId: number }>(
            'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'build-tutorials-screen' }, sessionId,
          ).catch(() => undefined);
          if (!world) continue;
          const candidate: Frame = { sessionId, contextId: world.executionContextId, targetId: target.targetId };
          const found = await this.evaluate<string>(candidate, 'document.title').catch(() => '');
          if (found === title) return candidate;
          if (found) seen.push(found);
        }
      }
      await sleep(100);
    }
    throw new ScreenUnreadable(`no webview titled ${JSON.stringify(title)} appeared within ${timeoutMs} ms (saw: ${JSON.stringify([...new Set(seen)])})`);
  }

  /** The workbench itself — notifications live there, not in any webview. */
  async workbench(): Promise<Frame> {
    const { targetInfos } = await this.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && t.url.includes('workbench'));
    if (!page) throw new ScreenUnreadable(`no workbench page among ${targetInfos.length} DevTools targets`);
    try {
      return await this.worldIn(page.targetId);
    } catch (err) {
      if (!stale(err)) throw err;
      this.sessions.delete(page.targetId); // the cached session died (seen under heavy load) — attach afresh, once
      return this.worldIn(page.targetId);
    }
  }

  private async worldIn(targetId: string): Promise<Frame> {
    const sessionId = await this.session(targetId);
    const tree = await this.send<{ frameTree: FrameNode }>('Page.getFrameTree', {}, sessionId);
    const world = await this.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'build-tutorials-screen' }, sessionId,
    );
    return { sessionId, contextId: world.executionContextId };
  }

  /**
   * A reader for the webview titled `title` that survives its frame being replaced: when a read
   * fails because the session or the isolated world it used has gone (a re-render, an iframe the
   * renderer moved, a session dropped under load), it finds the frame again and retries ONCE. Any
   * other failure — and a second stale one — is thrown, never swallowed.
   */
  reader<T>(title: string, expression: string, first?: Frame, exclude: ReadonlySet<string> = new Set()): () => Promise<T> {
    let frame = first;
    return async () => {
      frame ??= await this.webview(title, undefined, exclude);
      try {
        return await this.evaluate<T>(frame, expression);
      } catch (err) {
        if (!stale(err)) throw err;
        for (const [targetId, sessionId] of this.sessions) if (sessionId === frame.sessionId) this.sessions.delete(targetId);
        frame = await this.webview(title, undefined, exclude);
        return this.evaluate<T>(frame, expression);
      }
    };
  }

  /** Evaluates `expression` in the frame's isolated world and returns its value (JSON-serialisable). */
  async evaluate<T>(frame: Frame, expression: string): Promise<T> {
    const reply = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, contextId: frame.contextId, returnByValue: true, awaitPromise: true },
      frame.sessionId,
    );
    if (reply.exceptionDetails) {
      throw new Error(`in the page: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    }
    return reply.result.value as T;
  }

  /** The text of every notification VS Code is showing in the corner right now, top to bottom. */
  async notifications(): Promise<string[]> {
    const bench = await this.workbench();
    return this.evaluate<string[]>(bench, `Array.from(document.querySelectorAll('.notification-toast-container .notification-list-item')).map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
  }

  /**
   * The text of every notification in the notification CENTRE's list — every one not yet closed,
   * drawn or not as a toast. The list is only rendered while the centre is open, so a caller opens
   * it first (`notifications.showList`) and closes it after.
   */
  async listedNotifications(): Promise<string[]> {
    const bench = await this.workbench();
    return this.evaluate<string[]>(bench, `Array.from(document.querySelectorAll('.notifications-center .notification-list-item')).map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`);
  }

  /**
   * Presses the button labelled `label` on the notification whose text contains `containing` —
   * the real button, the way a person would. Returns false when there is no such button.
   */
  async pressNotificationButton(containing: string, label: string): Promise<boolean> {
    const bench = await this.workbench();
    return this.evaluate<boolean>(bench, `(() => {
      const items = Array.from(document.querySelectorAll('.notification-toast-container .notification-list-item'));
      const item = items.find((el) => el.innerText.includes(${JSON.stringify(containing)}));
      if (!item) return false;
      const button = Array.from(item.querySelectorAll('.monaco-button, a.action-label, [role=button]'))
        .find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)} || el.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
  }
}

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

function flatten(node: FrameNode): Array<{ id: string; url: string }> {
  return [node.frame, ...(node.childFrames ?? []).flatMap(flatten)];
}

/** The two ways a DevTools handle goes stale: its session detached, or its isolated world went with the frame. */
function stale(err: unknown): boolean {
  return err instanceof Error && /Session with given id not found|Cannot find context with specified id|No frame with given id/.test(err.message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `read` until it returns something different from `before` (compared as JSON), or the
 * time runs out — and then returns whatever it last read. A caller asserting "this press changed
 * the screen" compares the result with `before`; one asserting "nothing changed" waits the full
 * `ms` by passing a `before` it expects to keep seeing.
 */
export async function nextFrame<T>(read: () => Promise<T>, before: T, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  const was = JSON.stringify(before);
  let now = await read();
  while (JSON.stringify(now) === was && Date.now() < deadline) {
    await sleep(50);
    now = await read();
  }
  return now;
}

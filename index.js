/**
 * Host half of the fullscreen screenshot overlay.
 *
 * The capture has to happen here, not in the page: a browser can only share a
 * screen through a picker the person has to answer every time, while this
 * process sits in the same interactive desktop session as the window.
 *
 * Everything funnels through ONE persistent PowerShell worker. Starting a
 * process and compiling the P/Invoke helper for every click is what made the
 * overlay feel sluggish (about two seconds per capture); the worker pays that
 * cost once at activation and then answers each capture in a few hundred
 * milliseconds over stdin/stdout.
 *
 * Routes:
 *   GET  /api/fullscreen-shot          whole virtual screen as PNG
 *   GET  /api/fullscreen-shot/windows  top-level windows + the virtual bounds
 *   GET  /api/fullscreen-shot/window   one window's own rendering (id=hwnd)
 *   POST /api/fullscreen-shot          save posted PNG bytes, return the path
 *
 * The window route exists because "screenshot this window" is often asked
 * about a window that is covered: PrintWindow asks the window to render itself,
 * so the answer does not depend on what happens to be on top of it.
 *
 * @module @local/fullscreen-shot
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Whole-screen capture and the posted-save endpoint. */
const CAPTURE_PATH = '/api/fullscreen-shot'
/** Top-level window list plus the virtual-screen bounds. */
const WINDOWS_PATH = '/api/fullscreen-shot/windows'
/** One window's own rendering, selected by `?id=<hwnd>`. */
const WINDOW_PATH = '/api/fullscreen-shot/window'
/** Where every saved shot lands: one folder, easy to clean up. */
const SAVE_DIR = join(homedir(), 'Downloads', 'dsh-screenshots')
/** One command must not pin the overlay forever. */
const COMMAND_TIMEOUT_MS = 15000
/** Install layout of the optional vision bridge under a profile directory. */
const MODLENS_CLI = ['node_modules', '@liustack', 'modlens', 'dist', 'main.js']
/** Vision reading is slower than a capture; it gets its own budget. */
const READING_TIMEOUT_MS = 110000
/** Largest PNG body the save route accepts. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** This half needs the loopback route and the agent tool registry. */
export const inject = ['webServer', 'tools']

/** Prefer the exact shipped interpreter: a broken PATH must not break capture. */
function powerShellPath() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root !== '') {
    const shipped = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(shipped)) return shipped
  }
  return 'powershell.exe'
}

/** PowerShell reports multi-line failures; the page shows one line of them. */
function squeeze(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * The worker: load the native helpers once, then serve commands.
 *
 * One line in, one line out. `SCREEN <png>`, `WINDOW <hwnd> <png>`,
 * `LIST <json>`, `PING`. Anything else answers `ERR`. The PNG and JSON go to
 * files on disk so no binary ever crosses the console encoding.
 */
const WORKER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DshShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  public static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) == 0) return r;
    GetWindowRect(h, out r);
    return r;
  }
  /** One LockBits pass instead of thousands of GetPixel calls. */
  public static bool IsBlank(System.Drawing.Bitmap b) {
    var rect = new System.Drawing.Rectangle(0, 0, b.Width, b.Height);
    var data = b.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    try {
      int total = data.Stride * b.Height;
      byte[] buffer = new byte[total];
      System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buffer, 0, total);
      for (int i = 0; i + 2 < total; i += 97 * 4) {
        if (buffer[i] > 8 || buffer[i + 1] > 8 || buffer[i + 2] > 8) return false;
      }
      return true;
    } finally {
      b.UnlockBits(data);
    }
  }
  public static List<string> Rows;
  public static bool Visit(IntPtr h, IntPtr p) {
    if (!IsWindowVisible(h) || IsIconic(h)) return true;
    RECT r = Frame(h);
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 48 || ht < 48) return true;
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    string title = sb.ToString().Replace('\\t', ' ').Replace('\\r', ' ').Replace('\\n', ' ');
    if (title.Length == 0) return true;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    Rows.Add(h.ToInt64().ToString() + "\\t" + pid.ToString() + "\\t" + r.Left + "\\t" + r.Top + "\\t" + w + "\\t" + ht + "\\t" + title);
    return true;
  }
  public static List<string> List() {
    Rows = new List<string>();
    EnumWindows(Visit, IntPtr.Zero);
    return Rows;
  }
}
'@
[DshShot]::SetProcessDPIAware() | Out-Null

function Write-Ok { [Console]::Out.WriteLine('OK'); [Console]::Out.Flush() }
function Write-Err($message) {
  $one = ([string]$message -replace '\\s+', ' ').Trim()
  [Console]::Out.WriteLine('ERR' + [char]9 + $one)
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $parts = $line.Split([char]9)
  try {
    switch ($parts[0]) {
      'PING' { Write-Ok }
      'SCREEN' {
        $out = $parts[1]
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $graphics.Dispose()
        $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        Write-Ok
      }
      'WINDOW' {
        $handle = [IntPtr][Int64]$parts[1]
        $out = $parts[2]
        $frame = [DshShot]::Frame($handle)
        $width = $frame.Right - $frame.Left
        $height = $frame.Bottom - $frame.Top
        if ($width -le 0 -or $height -le 0) { throw 'window-empty' }
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        [DshShot]::PrintWindow($handle, $hdc, 2) | Out-Null
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
        if ([DshShot]::IsBlank($bitmap)) {
          $screen = [System.Drawing.Graphics]::FromImage($bitmap)
          $screen.CopyFromScreen($frame.Left, $frame.Top, 0, 0, $bitmap.Size)
          $screen.Dispose()
        }
        $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        Write-Ok
      }
      'LIST' {
        $out = $parts[1]
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $rows = New-Object System.Collections.ArrayList
        foreach ($row in [DshShot]::List()) {
          $fields = $row.Split([char]9)
          [void]$rows.Add([pscustomobject]@{
            id = $fields[0]; pid = [int]$fields[1]; left = [int]$fields[2]; top = [int]$fields[3];
            width = [int]$fields[4]; height = [int]$fields[5]; title = $fields[6]
          })
        }
        $payload = [pscustomobject]@{
          screen = [pscustomobject]@{ left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }
          windows = @($rows)
        }
        $json = $payload | ConvertTo-Json -Depth 4 -Compress
        [System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok
      }
      default { Write-Err 'unknown-command' }
    }
  } catch {
    Write-Err ($_.Exception.Message)
  }
}
`

/**
 * One long-lived PowerShell, one command at a time.
 *
 * The worker is started lazily and restarted after a crash or a timeout; every
 * command is a line on stdin and a single line back, so a stuck command can be
 * abandoned by killing the process without leaving a half-read reply.
 */
class CaptureWorker {
  constructor() {
    this.child = null
    this.ready = null
    this.pending = null
    this.buffer = ''
    this.queue = Promise.resolve()
    this.scriptFile = null
  }

  /** Start (or reuse) the worker and wait until its helpers are compiled. */
  ensure() {
    if (this.ready !== null) return this.ready
    if (process.platform !== 'win32') return Promise.reject(new Error('platform-unsupported'))
    this.ready = (async () => {
      if (this.scriptFile === null) {
        const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-worker-'))
        this.scriptFile = join(dir, 'worker.ps1')
        await writeFile(this.scriptFile, '\uFEFF' + WORKER_SCRIPT, 'utf8')
      }
      await new Promise((resolve, reject) => {
        let child
        try {
          child = spawn(powerShellPath(), [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.scriptFile,
          ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (error) {
          reject(error)
          return
        }
        this.child = child
        this.buffer = ''
        let said = false
        let stderr = ''
        const timer = setTimeout(() => {
          if (!said) reject(new Error('worker-start-timeout'))
        }, COMMAND_TIMEOUT_MS)
        child.stdout.on('data', (chunk) => {
          this.buffer += chunk.toString('utf8')
          let index = this.buffer.indexOf('\n')
          while (index !== -1) {
            const line = this.buffer.slice(0, index).replace(/\r$/, '')
            this.buffer = this.buffer.slice(index + 1)
            this.consume(line)
            if (!said && line === 'READY') {
              said = true
              clearTimeout(timer)
              resolve()
            }
            index = this.buffer.indexOf('\n')
          }
        })
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 2000) stderr += String(chunk)
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          if (!said) reject(error)
          this.fail(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (!said) reject(new Error(squeeze(stderr) || 'worker-exit-' + String(code)))
          this.fail(new Error(squeeze(stderr) || 'worker-exit-' + String(code)))
        })
      })
    })().catch((error) => {
      this.ready = null
      this.child = null
      throw error
    })
    return this.ready
  }

  /** Settle the one outstanding command with a worker line. */
  consume(line) {
    const pending = this.pending
    this.pending = null
    if (pending === null) return
    clearTimeout(pending.timer)
    if (line === 'OK') pending.resolve()
    else if (line.startsWith('ERR\t')) pending.reject(new Error(line.slice(4)))
    else pending.resolve()
  }

  /** Drop the worker and every waiter: the next call starts a fresh one. */
  fail(error) {
    const pending = this.pending
    this.pending = null
    const child = this.child
    this.child = null
    this.ready = null
    if (child !== null) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    if (pending !== null) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  /** Run one command; commands serialize so replies stay paired. */
  run(command, timeoutMs) {
    const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : COMMAND_TIMEOUT_MS
    const task = this.queue.then(async () => {
      await this.ensure()
      return await new Promise((resolve, reject) => {
        const child = this.child
        if (child === null) {
          reject(new Error('worker-unavailable'))
          return
        }
        const timer = setTimeout(() => {
          this.pending = null
          this.fail(new Error('capture-timeout'))
          reject(new Error('capture-timeout'))
        }, budget)
        this.pending = { resolve, reject, timer }
        child.stdin.write(command + '\n', (error) => {
          if (error) {
            clearTimeout(timer)
            this.pending = null
            reject(error)
          }
        })
      })
    })
    this.queue = task.catch(() => {})
    return task
  }

  /**
   * Release the process and its script file. The worker itself stays reusable:
   * a plugin restart re-warms the same instance instead of starting from zero.
   */
  dispose() {
    this.fail(new Error('worker-restarting'))
    const script = this.scriptFile
    this.scriptFile = null
    if (script !== null) {
      const dir = dirname(script)
      void rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// One worker for the whole process; activation warms it so the first click
// already answers in milliseconds instead of paying the startup cost.
const worker = new CaptureWorker()

/** Prepare a throwaway directory that one command writes into. */
async function withTempDir(prefix, work) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The whole virtual screen as PNG bytes. */
async function captureScreenPng() {
  return await withTempDir('dsh-shot-out-', async (dir) => {
    const target = join(dir, 'screen-' + randomUUID() + '.png')
    await worker.run('SCREEN\t' + target)
    const bytes = await readFile(target)
    if (bytes.length === 0) throw new Error('capture-empty')
    return bytes
  })
}

/** Top-level windows in z-order, topmost first, with the virtual bounds. */async function listWindows() {
  return await withTempDir('dsh-shot-list-', async (dir) => {
    const target = join(dir, 'windows.json')
    await worker.run('LIST\t' + target)
    const parsed = JSON.parse(await readFile(target, 'utf8'))
    const screen = parsed && parsed.screen ? parsed.screen : null
    if (!screen || !(screen.width > 0) || !(screen.height > 0)) throw new Error('screen-bounds-missing')
    const windows = Array.isArray(parsed.windows) ? parsed.windows : []
    return {
      screen: {
        left: Number(screen.left) || 0,
        top: Number(screen.top) || 0,
        width: Number(screen.width),
        height: Number(screen.height),
      },
      windows: windows
        .filter((win) => win && win.id && win.width > 0 && win.height > 0)
        // Our own window is left out on purpose: asking the app to print
        // itself while its UI thread is busy is the one reliable way to hang.
        .filter((win) => Number(win.pid) !== process.pid && Number(win.pid) !== process.ppid)
        .map((win) => ({
          id: String(win.id),
          left: Number(win.left) || 0,
          top: Number(win.top) || 0,
          width: Number(win.width),
          height: Number(win.height),
          title: typeof win.title === 'string' ? win.title.slice(0, 200) : '',
        })),
    }
  })
}

/** One window's own rendering as PNG bytes. */
async function captureWindowPng(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('window-id-invalid')
  return await withTempDir('dsh-shot-win-', async (dir) => {
    const target = join(dir, 'window-' + randomUUID() + '.png')
    await worker.run('WINDOW\t' + String(id) + '\t' + target)
    const bytes = await readFile(target)
    if (bytes.length === 0) throw new Error('capture-empty')
    return bytes
  })
}

/** `shot-20261108-104233.png`: sortable, one folder, no name collisions. */
function shotName(prefix) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = String(now.getFullYear())
    + pad(now.getMonth() + 1)
    + pad(now.getDate())
    + '-'
    + pad(now.getHours())
    + pad(now.getMinutes())
    + pad(now.getSeconds())
  return prefix + '-' + stamp + '.png'
}

/** Write captured or posted bytes into the one screenshot folder. */
async function saveShot(bytes, prefix) {
  await mkdir(SAVE_DIR, { recursive: true })
  const file = join(SAVE_DIR, shotName(prefix))
  await writeFile(file, bytes)
  return { file, bytes: bytes.length }
}

// ------------------------------------------------------------ vision bridge

/** Locate the optional modlens CLI in the running profile, then in the usual ones. */
function modlensCliPath() {
  const candidates = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') candidates.push(join(profileDir, ...MODLENS_CLI))
  for (const name of ['desktop', 'web', 'headless']) {
    candidates.push(join(homedir(), '.dsh', 'profiles', name, ...MODLENS_CLI))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The CLI needs a real Node: the desktop host itself is an Electron binary. */
function nodeCommand() {
  const explicit = process.env.DSH_NODE_PATH
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return { command: explicit, env: {} }
  return { command: 'node', env: {} }
}

/**
 * Ask the vision bridge to read a saved capture.
 *
 * The CLI writes structured evidence to a file, so nothing large crosses the
 * console; the result keeps the shape modlens publishes (summary, ocr, layout,
 * semantics, visual, uncertainty) and is trimmed to what a text model can use.
 */
async function readWithModlens(file, focus) {
  const cli = modlensCliPath()
  if (cli === null) throw new Error('modlens-not-installed')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-read-'))
  const target = join(dir, 'evidence.json')
  try {
    const args = [cli, 'analyze', '-i', file, '-o', target, '--timeout', String(READING_TIMEOUT_MS - 10000)]
    if (typeof focus === 'string' && focus.trim() !== '') args.push('--prompt', focus.trim().slice(0, 500))
    const node = nodeCommand()
    await runProcess(node.command, args, READING_TIMEOUT_MS, node.env)
    const evidence = JSON.parse(await readFile(target, 'utf8'))
    return trimEvidence(evidence)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Keep the reading useful without pasting a whole page of OCR into the turn. */
function trimEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '')
  const lines = Array.isArray(evidence.ocr && evidence.ocr.lines) ? evidence.ocr.lines.slice(0, 60) : []
  const regions = Array.isArray(evidence.layout && evidence.layout.regions)
    ? evidence.layout.regions.slice(0, 40)
    : []
  const entities = Array.isArray(evidence.semantics && evidence.semantics.entities)
    ? evidence.semantics.entities.slice(0, 20)
    : []
  return {
    summary: text(evidence.summary, 1200),
    ocr: {
      full_text: text(evidence.ocr && evidence.ocr.full_text, 4000),
      lines,
    },
    layout: { regions },
    semantics: {
      scene: text(evidence.semantics && evidence.semantics.scene, 400),
      intent: text(evidence.semantics && evidence.semantics.intent, 400),
      entities,
    },
    uncertainty: Array.isArray(evidence.uncertainty) ? evidence.uncertainty.slice(0, 10) : [],
  }
}

/** Spawn a process, collect stderr, and reject with one readable line. */
function runProcess(command, args, timeoutMs, extraEnv) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      })
    } catch (error) {
      reject(error)
      return
    }
    let stderr = ''
    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish(() => reject(new Error('reading-timeout')))
    }, timeoutMs)
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve()
        else reject(new Error(squeeze(stderr) || 'reading-exit-' + String(code)))
      })
    })
  })
}

/** The overlay is a local surface: never answer a non-loopback socket. */
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** A browser request carries `Origin`; a cross-origin call must not be admitted. */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function respondPng(res, png) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'content-length': png.length,
  })
  res.end(png)
}

/** Read a posted body with a hard ceiling. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Both endpoints share the same local-only admission. */
function admit(req, res) {
  if (!isLoopback(req) || !isSameOrigin(req)) {
    respondJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  return true
}

/** One failure line, whatever shape it arrived in. */
function sweep(error) {
  return error && error.message ? squeeze(error.message) : 'capture-failed'
}

/** Whole-screen capture (GET) and saving a posted PNG (POST). */
function createCaptureRoute() {
  return {
    kind: 'exact',
    path: CAPTURE_PATH,
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (req.method === 'GET') {
        try {
          respondPng(res, await captureScreenPng())
        } catch (error) {
          respondJson(res, 500, { ok: false, error: sweep(error) })
        }
        return
      }
      if (req.method === 'POST') {
        try {
          const bytes = await readBody(req)
          if (bytes.length === 0) {
            respondJson(res, 400, { ok: false, error: 'body-empty' })
            return
          }
          const saved = await saveShot(bytes, 'shot')
          respondJson(res, 200, { ok: true, file: saved.file, bytes: saved.bytes })
        } catch (error) {
          const message = sweep(error)
          respondJson(res, message === 'body-too-large' ? 413 : 500, { ok: false, error: message })
        }
        return
      }
      respondJson(res, 405, { ok: false, error: 'method-not-allowed' })
    },
  }
}

/** Window list for the hover-and-snap step. */
function createWindowsRoute() {
  return {
    kind: 'exact',
    path: WINDOWS_PATH,
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (req.method !== 'GET') {
        respondJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const listed = await listWindows()
        respondJson(res, 200, { ok: true, screen: listed.screen, windows: listed.windows })
      } catch (error) {
        respondJson(res, 500, { ok: false, error: sweep(error) })
      }
    },
  }
}

/** One window's own rendering. */
function createWindowRoute() {
  return {
    kind: 'exact',
    path: WINDOW_PATH,
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (req.method !== 'GET') {
        respondJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      let id = ''
      try {
        id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || ''
      } catch {
        id = ''
      }
      if (id === '') {
        respondJson(res, 400, { ok: false, error: 'window-id-required' })
        return
      }
      try {
        respondPng(res, await captureWindowPng(id))
      } catch (error) {
        respondJson(res, 500, { ok: false, error: sweep(error) })
      }
    },
  }
}

/** The same capture, reached through one tool instead of the overlay. */
function createTool() {
  return {
    name: 'screen_capture',
    description:
      'Capture the whole desktop screen (every monitor) as one PNG on this machine, and optionally '
      + 'read it back through the vision bridge. Use it when the person asks about what is on screen, '
      + 'or says "screenshot this". Without `read` it returns the saved path (call read_image on it '
      + 'to look at the picture); with `read: true` it also returns OCR text, layout regions and '
      + 'semantics in the same call, which a text-only model can use directly.',
    parameters: {
      type: 'object',
      properties: {
        savePath: {
          type: 'string',
          description: 'Absolute PNG path to write. Defaults to the dsh-screenshots folder in Downloads.',
        },
        read: {
          type: 'boolean',
          description: 'Also run the vision bridge over the capture and return its structured evidence.',
        },
        focus: {
          type: 'string',
          description: 'Optional question to steer the reading, e.g. "what error is shown?"',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const requested = typeof args.savePath === 'string' ? args.savePath.trim() : ''
      const wantReading = args.read === true
      const focus = typeof args.focus === 'string' ? args.focus : ''
      try {
        const png = await captureScreenPng()
        let file
        if (requested !== '') {
          await mkdir(dirname(requested), { recursive: true })
          await writeFile(requested, png)
          file = requested
        } else {
          file = (await saveShot(png, 'shot')).file
        }
        const result = { ok: true, file, bytes: png.length, capturedAt: new Date().toISOString() }
        if (wantReading) {
          try {
            result.reading = await readWithModlens(file, focus)
          } catch (error) {
            // The capture succeeded; report the missing reading instead of failing it.
            result.reading = null
            result.readingError = sweep(error)
          }
        } else {
          result.hint = 'Call read_image with this path to look at the capture, or repeat with read: true.'
        }
        return result
      } catch (error) {
        return { ok: false, error: sweep(error) }
      }
    },
  }
}

/** Host entry: one worker shared by the overlay's routes and the tool. */
export function apply(ctx) {
  ctx.effect(() => {
    // Warm the worker now: the first camera click should not pay for the
    // C# compile, and a failure here surfaces on the first request instead.
    void worker.ensure().catch(() => {})
    return () => worker.dispose()
  }, 'fullscreen-shot: capture worker')
  ctx.effect(() => ctx.webServer.register(createCaptureRoute()), 'fullscreen-shot: capture route')
  ctx.effect(() => ctx.webServer.register(createWindowsRoute()), 'fullscreen-shot: window list route')
  ctx.effect(() => ctx.webServer.register(createWindowRoute()), 'fullscreen-shot: window capture route')
  ctx.effect(() => ctx.tools.register(createTool()), 'fullscreen-shot: agent tool')
}

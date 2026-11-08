/**
 * Client half of the fullscreen screenshot overlay.
 *
 * The shape follows the browser's own capture tool rather than a form dialog:
 * clicking the seat freezes the screen under a dimmed, full-bleed copy of the
 * capture, so the very first drag already selects something. A small floating
 * toolbar does the rest — copy, save, retake, or switch to picking a window —
 * and Enter/Ctrl+C copies the selection and closes.
 *
 * Three ways to get the picture you meant:
 *   全屏    the virtual desktop, every monitor, at physical resolution;
 *   窗口    hover a window and click: the Host asks that window to render
 *           itself, so even a covered window comes back whole;
 *   框选    drag anywhere on the frozen picture; the selection is cropped at
 *           capture resolution exactly when you copy or save.
 *
 * Saving posts the (possibly cropped) PNG to the Host, which stores it in one
 * folder and returns its path; that path is inserted into the composer draft,
 * so the model can read the file instead of carrying the pixels.
 *
 * @module @gyl9999/dsh-screenshot/client
 */
window.__ModuleLoader__.load({
  id: '@gyl9999/dsh-screenshot',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'fullscreen-shot'
    /** Document-relative so a sub-path deployment stays inside its entry directory. */
    const CAPTURE_API = 'api/fullscreen-shot'
    const WINDOWS_API = 'api/fullscreen-shot/windows'
    const WINDOW_API = 'api/fullscreen-shot/window'

    const zh = {
      'action.label': '截屏',
      'action.title': '截屏 · 全屏 / 窗口 / 框选（Ctrl+Alt+S）',
      'dialog.title': '截屏',
      'dialog.sub.ready': '整个屏幕 · {w} × {h}',
      'dialog.sub.capturing': '正在截取整个屏幕…',
      'dialog.sub.browser': '浏览器共享的画面 · {w} × {h}',
      'dialog.sub.region': '选区 · {w} × {h}',
      'dialog.sub.window': '窗口 · {w} × {h}',
      'dialog.hint': '在画面上拖动即可框选 · Enter 复制 · Esc 关闭',
      'dialog.hint.noShot': '拖不动就等截图出来',
      'dialog.capturing': '截取中…',
      'dialog.copy': '复制',
      'dialog.copied': '已复制，按 Ctrl + V 粘进对话框。',
      'dialog.copyFailed': '剪贴板写入被拒绝，请改用「保存」。',
      'dialog.save': '保存',
      'dialog.saving': '保存中…',
      'dialog.savedInserted': '已存到本机，路径已插入输入框。',
      'dialog.savedDownload': '本机服务没响应，改为下载到浏览器下载目录。',
      'dialog.retake': '重截',
      'dialog.browser': '浏览器截屏',
      'dialog.close': '关闭',
      'dialog.select.hint': '拖出一个矩形，只保留框住的部分',
      'dialog.select.size': '{w} × {h}',
      'dialog.select.clear': '取消选区',
      'dialog.select.failed': '裁切失败，请重新框选。',
      'dialog.window.start': '窗口',
      'dialog.window.loading': '正在读取窗口…',
      'dialog.window.hint': '把鼠标移到想截的窗口上，点一下即可。被遮挡的窗口也能拿到完整内容。',
      'dialog.window.failed': '读不到窗口列表：{message}',
      'dialog.window.shot': '正在截取这个窗口…',
      'dialog.error.title': '这次没截到',
      'dialog.error.platform': '当前系统只实现了 Windows 桌面截屏。',
      'dialog.error.offline': '本机截屏服务没有响应，可能插件刚重载。可以重试，或改用浏览器截屏。',
      'dialog.error.host': '截屏失败：{message}',
      'dialog.error.browser': '浏览器截屏被取消，或这个页面不支持共享屏幕。',
      'dialog.error.browserUnsupported': '这个页面没有可用的屏幕共享接口，请改用桌面截屏。',
    }

    const en = {
      'action.label': 'Shot',
      'action.title': 'Screenshot · screen, window, or area (Ctrl+Alt+S)',
      'dialog.title': 'Screenshot',
      'dialog.sub.ready': 'Entire screen · {w} × {h}',
      'dialog.sub.capturing': 'Capturing the entire screen…',
      'dialog.sub.browser': 'Browser-shared surface · {w} × {h}',
      'dialog.sub.region': 'Selection · {w} × {h}',
      'dialog.sub.window': 'Window · {w} × {h}',
      'dialog.hint': 'Drag to select · Enter copies · Esc closes',
      'dialog.hint.noShot': 'Wait for the capture to land',
      'dialog.capturing': 'Capturing…',
      'dialog.copy': 'Copy',
      'dialog.copied': 'Copied. Press Ctrl + V to paste it.',
      'dialog.copyFailed': 'The clipboard write was refused; use Save instead.',
      'dialog.save': 'Save',
      'dialog.saving': 'Saving…',
      'dialog.savedInserted': 'Saved, and the path is now in the composer.',
      'dialog.savedDownload': 'The local service did not answer, so it was downloaded instead.',
      'dialog.retake': 'Retake',
      'dialog.browser': 'Browser capture',
      'dialog.close': 'Close',
      'dialog.select.hint': 'Drag a rectangle to keep only that part',
      'dialog.select.size': '{w} × {h}',
      'dialog.select.clear': 'Clear selection',
      'dialog.select.failed': 'The crop failed; drag the rectangle again.',
      'dialog.window.start': 'Window',
      'dialog.window.loading': 'Reading windows…',
      'dialog.window.hint': 'Move the pointer over the window you want and click. Covered windows still come back whole.',
      'dialog.window.failed': 'Could not read the window list: {message}',
      'dialog.window.shot': 'Capturing that window…',
      'dialog.error.title': 'No capture this time',
      'dialog.error.platform': 'Only Windows desktop capture is implemented so far.',
      'dialog.error.offline': 'The local capture service did not answer; the plugin may have just reloaded. Retry, or use browser capture.',
      'dialog.error.host': 'Capture failed: {message}',
      'dialog.error.browser': 'The browser share was cancelled, or this page cannot share a screen.',
      'dialog.error.browserUnsupported': 'This page has no screen-sharing API. Use the desktop capture instead.',
    }

    // ------------------------------------------------------------- capture

    /** Host route: the whole desktop, already encoded, no picker involved. */
    async function captureFromHost() {
      let response
      try {
        response = await fetch(CAPTURE_API, { method: 'GET', cache: 'no-store', headers: { accept: 'image/png' } })
      } catch {
        throw new Error('offline')
      }
      if (!response.ok) throw new Error(await readFailure(response))
      return await requireBlob(response)
    }

    /** Host route: one window rendering itself, whatever is on top of it. */
    async function captureWindow(id) {
      const response = await fetch(WINDOW_API + '?id=' + encodeURIComponent(id), {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'image/png' },
      })
      if (!response.ok) throw new Error(await readFailure(response))
      return await requireBlob(response)
    }

    /** Host route: window rectangles plus the virtual-screen map they belong to. */
    async function readWindows() {
      const response = await fetch(WINDOWS_API, { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(await readFailure(response))
      const body = await response.json()
      if (!body || body.ok !== true || !body.screen) throw new Error('window-list-empty')
      return { screen: body.screen, windows: Array.isArray(body.windows) ? body.windows : [] }
    }

    /** Host route: store the posted PNG and hand back its path. */
    async function saveToHost(blob) {
      const response = await fetch(CAPTURE_API, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: blob,
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || body.ok !== true || typeof body.file !== 'string') {
        throw new Error(body && typeof body.error === 'string' ? body.error : 'save-failed')
      }
      return body.file
    }

    async function readFailure(response) {
      try {
        const body = await response.json()
        if (body && typeof body.error === 'string' && body.error !== '') return body.error
      } catch {
        // A non-JSON body still carries its status in the message below.
      }
      return 'http-' + String(response.status)
    }

    async function requireBlob(response) {
      const blob = await response.blob()
      if (blob.size === 0) throw new Error('capture-empty')
      return blob
    }

    /** Fallback: the platform picker, for a machine the Host route cannot reach. */
    async function captureFromBrowser() {
      const media = navigator.mediaDevices
      if (!media || typeof media.getDisplayMedia !== 'function') throw new Error('browser-unsupported')
      let stream
      try {
        stream = await media.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      } catch {
        throw new Error('browser-cancelled')
      }
      const video = document.createElement('video')
      try {
        video.srcObject = stream
        video.muted = true
        video.playsInline = true
        await video.play()
        // Two frames: the first presentation can still be an empty texture.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const settings = stream.getVideoTracks().length > 0 ? stream.getVideoTracks()[0].getSettings() : {}
        const canvas = document.createElement('canvas')
        canvas.width = settings.width || video.videoWidth
        canvas.height = settings.height || video.videoHeight
        if (canvas.width === 0 || canvas.height === 0) throw new Error('capture-empty')
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (blob === null) throw new Error('capture-empty')
        return blob
      } finally {
        for (const track of stream.getTracks()) track.stop()
        video.srcObject = null
      }
    }

    /** Read the pixel size once so the header can state it. */
    async function measureBlob(blob) {
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob)
          const size = { width: bitmap.width, height: bitmap.height }
          if (typeof bitmap.close === 'function') bitmap.close()
          return size
        } catch {
          // Fall through to the <img> path for browsers without a decoder.
        }
      }
      return await new Promise((resolve) => {
        const image = new Image()
        const url = URL.createObjectURL(blob)
        image.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: image.naturalWidth, height: image.naturalHeight })
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          resolve({ width: 0, height: 0 })
        }
        image.src = url
      })
    }

    /** One failure line, in the person's language, with nothing transport-specific. */
    function describeFailure(error, source, t) {
      const message = error && typeof error.message === 'string' ? error.message : ''
      if (source === 'browser') {
        return message === 'browser-unsupported'
          ? t('dialog.error.browserUnsupported')
          : t('dialog.error.browser')
      }
      if (message === 'platform-unsupported') return t('dialog.error.platform')
      if (message === 'offline') return t('dialog.error.offline')
      return t('dialog.error.host').replace('{message}', message === '' ? 'capture-failed' : message)
    }

    /**
     * Cut a rectangle out of the current capture at its native resolution.
     * Fractions keep the rectangle valid across any preview size.
     */
    async function cropBlob(shot, selection) {
      const left = Math.min(selection.x0, selection.x1)
      const top = Math.min(selection.y0, selection.y1)
      const wantedX = Math.round(left * shot.width)
      const wantedY = Math.round(top * shot.height)
      const wantedW = Math.max(4, Math.round(Math.abs(selection.x1 - selection.x0) * shot.width))
      const wantedH = Math.max(4, Math.round(Math.abs(selection.y1 - selection.y0) * shot.height))
      const width = Math.max(4, Math.min(wantedW, shot.width - wantedX))
      const height = Math.max(4, Math.min(wantedH, shot.height - wantedY))
      const source = new Image()
      source.src = shot.url
      await source.decode()
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(source, wantedX, wantedY, width, height, 0, 0, width, height)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (blob === null) throw new Error('crop-failed')
      return { blob, width, height }
    }

    /**
     * Put the saved path into the composer draft.
     * `captureInsertion` freezes the selection/revision, `insertText` applies one
     * undoable edit if that revision is still current; a refused insert is not an
     * error here, the file is already saved and the notice says so.
     */
    function insertIntoComposer(inputActions, text) {
      if (!inputActions) return false
      if (typeof inputActions.captureInsertion !== 'function') return false
      if (typeof inputActions.insertText !== 'function') return false
      try {
        const span = inputActions.captureInsertion()
        inputActions.insertText(text + ' ', span)
        return true
      } catch {
        return false
      }
    }

    /** `screenshot-20261108-101812.png`, sortable inside one folder. */
    function fileName() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const day = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
      const clock = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
      return 'screenshot-' + day + '-' + clock + '.png'
    }

    // -------------------------------------------------------------- visuals

    const CSS = [
      '.fs-trigger{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 8px;',
      'border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:12px;cursor:pointer;transition:background .14s ease,color .14s ease}',
      '.fs-triggerLabel{font-size:12px;line-height:1;white-space:nowrap}',
      '.fs-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.fs-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.fs-overlay{position:fixed;inset:0;z-index:2147483000;background:#07090d;overflow:hidden;',
      'animation:fs-fade .12s ease-out}',
      '@keyframes fs-fade{from{opacity:0}to{opacity:1}}',
      '.fs-canvas{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0;',
      'box-sizing:border-box}',
      '.fs-frame{position:relative;display:block;line-height:0;overflow:hidden}',
      '.fs-frame[data-mode="pick"]{cursor:pointer}',
      '.fs-frame[data-mode="draw"]{cursor:crosshair}',
      '.fs-image{display:block;user-select:none;-webkit-user-drag:none}',
      '.fs-dim{position:absolute;inset:0;pointer-events:none;background:rgba(7,9,13,.5);',
      'transition:background .12s ease}',
      '.fs-marquee{position:absolute;pointer-events:none;border:1.5px solid #fff;',
      'box-shadow:0 0 0 9999px rgba(7,9,13,.5),0 0 0 1px rgba(7,9,13,.5)}',
      '.fs-snap{position:absolute;pointer-events:none;border:2px solid var(--dsw-alias-brand-primary);',
      'border-radius:2px;background:rgba(64,132,255,.08);box-shadow:0 0 0 9999px rgba(7,9,13,.45)}',
      '.fs-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:10px;',
      'padding:12px 16px;box-sizing:border-box;pointer-events:none;',
      'background:linear-gradient(rgba(7,9,13,.82),rgba(7,9,13,0))}',
      '.fs-topText{flex:1;min-width:0;font-size:12.5px;line-height:18px;color:#e8eef7;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'text-shadow:0 1px 2px rgba(0,0,0,.5)}',
      '.fs-topHint{color:rgba(232,238,247,.62);font-size:11.5px;margin-left:10px}',
      '.fs-chip{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;border:none;border-radius:8px;background:rgba(255,255,255,.1);',
      'color:#f2f6fb;cursor:pointer;transition:background .14s ease}',
      '.fs-chip:hover{background:rgba(255,255,255,.2)}',
      '.fs-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.fs-toolbar{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);display:flex;',
      'align-items:center;gap:6px;padding:6px;border-radius:12px;background:rgba(24,28,36,.92);',
      'border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 32px rgba(0,0,0,.5);',
      'backdrop-filter:blur(10px);animation:fs-rise .16s ease-out}',
      '@keyframes fs-rise{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}',
      '.fs-tool{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:none;',
      'border-radius:8px;background:transparent;color:#e6ecf5;font:inherit;font-size:12px;cursor:pointer;',
      'transition:background .13s ease,color .13s ease}',
      '.fs-tool:hover:not(:disabled){background:rgba(255,255,255,.12)}',
      '.fs-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.fs-tool:disabled{opacity:.45;cursor:default}',
      '.fs-toolDim{color:rgba(230,236,245,.55)}',
      '.fs-sep{width:1px;height:18px;margin:0 4px;background:rgba(255,255,255,.14)}',
      '.fs-accent{background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}',
      '.fs-accent:hover:not(:disabled){filter:brightness(1.08)}',
      '.fs-note{position:absolute;left:50%;bottom:70px;transform:translateX(-50%);max-width:70vw;',
      'padding:5px 10px;border-radius:8px;background:rgba(24,28,36,.88);color:#cfd8e6;font-size:11.5px;',
      'line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
      '.fs-sizeTag{position:absolute;pointer-events:none;padding:2px 6px;border-radius:6px;',
      'background:rgba(24,28,36,.9);color:#eef4fc;font-size:11px;line-height:15px;',
      'font-variant-numeric:tabular-nums;border:1px solid rgba(255,255,255,.16)}',
      '.fs-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:12px;color:#cfd8e6}',
      '.fs-spinner{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.2);',
      'border-top-color:var(--dsw-alias-brand-primary);animation:fs-spin .8s linear infinite}',
      '@keyframes fs-spin{to{transform:rotate(360deg)}}',
      '.fs-pendingText{font-size:12px;color:#cfd8e6}',
      '.fs-errorBox{max-width:460px;text-align:center;display:flex;flex-direction:column;gap:8px;padding:0 24px}',
      '.fs-errorTitle{font-size:13px;font-weight:600;color:#f2f6fb}',
      '.fs-errorBody{font-size:12px;line-height:18px;color:#aab6c6}',
    ].join('')

    /** Read the resolved accent off an element inside the themed tree. */
    function readAccent(element) {
      if (!element || typeof getComputedStyle !== 'function') return null
      const value = getComputedStyle(element).getPropertyValue('--dsw-alias-brand-primary').trim()
      return value === '' ? null : value
    }

    /** Relative luminance of a token value, so the accent's ink keeps its contrast. */
    function luminanceOf(css) {
      const value = String(css || '').trim()
      let red
      let green
      let blue
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
      if (hex !== null) {
        const digits = hex[1]
        const full = digits.length === 3
          ? digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
          : digits
        red = parseInt(full.slice(0, 2), 16)
        green = parseInt(full.slice(2, 4), 16)
        blue = parseInt(full.slice(4, 6), 16)
      } else {
        const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value)
        if (rgb === null) return null
        red = Number(rgb[1])
        green = Number(rgb[2])
        blue = Number(rgb[3])
      }
      const linear = (channel) => {
        const scaled = channel / 255
        return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    function Styles() {
      return h('style', { key: NS + '-css' }, CSS)
    }

    /** Stroked camera glyph, drawn at the current text color. */
    function CameraGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 8.6A2.6 2.6 0 0 1 6.6 6h1.1a1.6 1.6 0 0 0 1.35-.74l.62-.96A1.6 1.6 0 0 1 11.02 3.5h1.96a1.6 1.6 0 0 1 1.35.8l.62.96A1.6 1.6 0 0 0 16.3 6h1.1A2.6 2.6 0 0 1 20 8.6v7.8A2.6 2.6 0 0 1 17.4 19H6.6A2.6 2.6 0 0 1 4 16.4z',
        }),
        h('circle', { cx: 12, cy: 12.4, r: 3.3 }),
      )
    }

    function CloseGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }),
      )
    }

    // --------------------------------------------------------------- dialog

    /**
     * The overlay. It captures on mount, because opening it is the whole
     * gesture: one click on the camera and the frozen screen is already there
     * to drag on.
     * @param props - `t`, `onClose`, `anchor` (the seat element), `inputActions`.
     */
    function Dialog(props) {
      const t = props.t
      const onClose = props.onClose
      const anchor = props.anchor
      const inputActions = props.inputActions
      const [accent, setAccent] = React.useState(null)
      const [phase, setPhase] = React.useState('capturing')
      const [shot, setShot] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [notice, setNotice] = React.useState('')
      /** 'preview' (drag to select) | 'pick' (click a window) — what the pointer does. */
      const [mode, setMode] = React.useState('preview')
      const [selection, setSelection] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [hoverId, setHoverId] = React.useState('')
      const sequence = React.useRef(0)
      const alive = React.useRef(true)
      const objectUrl = React.useRef('')
      const frame = React.useRef(null)
      const stageRef = React.useRef(null)
      const dragStart = React.useRef(null)
      /** Displayed picture box in CSS px; a fraction of it is a fraction of the capture. */
      const [box, setBox] = React.useState(null)

      /** Swap the preview and release the previous blob URL in the same breath. */
      const replaceShot = React.useCallback((next) => {
        const previous = objectUrl.current
        objectUrl.current = next === null ? '' : next.url
        setShot(next)
        if (previous !== '' && previous !== objectUrl.current) URL.revokeObjectURL(previous)
      }, [])

      /** Run one whole-screen capture; a newer run always wins over a slower older one. */
      const run = React.useCallback(async (source) => {
        const id = sequence.current + 1
        sequence.current = id
        setPhase('capturing')
        setMessage('')
        setNotice('')
        setMode('preview')
        setSelection(null)
        setPicked(null)
        setHoverId('')
        dragStart.current = null
        try {
          const blob = source === 'browser' ? await captureFromBrowser() : await captureFromHost()
          const size = await measureBlob(blob)
          if (!alive.current || sequence.current !== id) return
          replaceShot({
            url: URL.createObjectURL(blob),
            blob,
            width: size.width,
            height: size.height,
            source,
            at: Date.now(),
          })
          setPhase('ready')
        } catch (error) {
          if (!alive.current || sequence.current !== id) return
          setMessage(describeFailure(error, source, t))
          setPhase('error')
        }
      }, [replaceShot, t])

      const close = React.useCallback(() => {
        onClose()
      }, [onClose])

      React.useEffect(() => {
        alive.current = true
        run('host')
        return () => {
          alive.current = false
          sequence.current += 1
          if (objectUrl.current !== '') {
            URL.revokeObjectURL(objectUrl.current)
            objectUrl.current = ''
          }
        }
        // The mount effect owns the first capture; later ones come from buttons.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Before the first paint, read the accent off the seat that opened us.
      React.useLayoutEffect(() => {
        const next = readAccent(anchor && anchor.current ? anchor.current : null)
        setAccent(next)
      }, [anchor])

      /**
       * Fit the picture to the window ourselves instead of leaving a percentage
       * chain to the browser: the frame then IS the image box, so a pointer
       * fraction is exactly the same fraction of the capture, and a 1:1 screen
       * comes back at 1:1 rather than through a scaled preview.
       */
      React.useLayoutEffect(() => {
        const node = stageRef.current
        if (node === null || shot === null) return
        const measure = () => {
          const rect = node.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          const scale = Math.min(rect.width / shot.width, rect.height / shot.height, 1)
          setBox({
            width: Math.max(1, Math.round(shot.width * scale)),
            height: Math.max(1, Math.round(shot.height * scale)),
          })
        }
        measure()
        if (typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [shot])

      // Window picking needs the live list; fetch it when the mode starts.
      React.useEffect(() => {
        if (mode !== 'pick' || picked !== null) return
        let cancelled = false
        setNotice(t('dialog.window.loading'))
        readWindows()
          .then((list) => {
            if (cancelled) return
            setPicked(list)
            setNotice(t('dialog.window.hint'))
          })
          .catch((error) => {
            if (cancelled) return
            const detail = error && error.message ? error.message : 'window-list-failed'
            setNotice(t('dialog.window.failed').replace('{message}', detail))
            setMode('preview')
          })
        return () => {
          cancelled = true
        }
      }, [mode, picked, t])

      /** A pointer position as a 0..1 fraction of the displayed picture. */
      const pointInFrame = (event) => {
        const node = frame.current
        if (node === null) return null
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        }
      }

      /** Screen point of a pointer fraction, using the capture's own bounds. */
      const screenPointOf = (fraction) => {
        if (picked === null || fraction === null) return null
        return {
          x: picked.screen.left + fraction.x * picked.screen.width,
          y: picked.screen.top + fraction.y * picked.screen.height,
        }
      }

      /** Topmost window under a screen point; the list arrives in z-order. */
      const windowAt = (point) => {
        if (picked === null || point === null) return null
        for (const win of picked.windows) {
          if (point.x >= win.left && point.x < win.left + win.width
            && point.y >= win.top && point.y < win.top + win.height) return win
        }
        return null
      }

      /** Drag out a rectangle (or pick a window) straight on the frozen picture. */
      const beginSelection = (event) => {
        if (mode === 'pick') {
          const win = windowAt(screenPointOf(pointInFrame(event)))
          if (win !== null) void capturePickedWindow(win)
          return
        }
        if (mode !== 'preview' && mode !== 'draw') return
        if (phase !== 'ready') return
        const start = pointInFrame(event)
        if (start === null) return
        event.preventDefault()
        dragStart.current = start
        setSelection({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
        const onMove = (moveEvent) => {
          const next = pointInFrame(moveEvent)
          if (next === null || dragStart.current === null) return
          setSelection({ x0: dragStart.current.x, y0: dragStart.current.y, x1: next.x, y1: next.y })
        }
        const onUp = () => {
          dragStart.current = null
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      /** Track which window a pointer is over while picking. */
      const trackHover = (event) => {
        if (mode !== 'pick') return
        const win = windowAt(screenPointOf(pointInFrame(event)))
        const id = win === null ? '' : win.id
        if (id !== hoverId) setHoverId(id)
      }

      /** Ask the Host for one window's own rendering. */
      const capturePickedWindow = async (win) => {
        const id = sequence.current + 1
        sequence.current = id
        setPhase('capturing')
        setNotice(t('dialog.window.shot'))
        try {
          const blob = await captureWindow(win.id)
          const size = await measureBlob(blob)
          if (!alive.current || sequence.current !== id) return
          replaceShot({
            url: URL.createObjectURL(blob),
            blob,
            width: size.width,
            height: size.height,
            source: 'window',
            title: win.title,
            at: Date.now(),
          })
          setMode('preview')
          setSelection(null)
          setNotice('')
          setPhase('ready')
        } catch (error) {
          if (!alive.current || sequence.current !== id) return
          setMessage(describeFailure(error, 'host', t))
          setMode('preview')
          setPhase('error')
        }
      }

      /** The blob the current action should use: the selection, or the whole shot. */
      const blobForAction = React.useCallback(async () => {
        if (shot === null) throw new Error('no-shot')
        if (selection === null) return { blob: shot.blob, cropped: false }
        const cropped = await cropBlob(shot, selection)
        return { blob: cropped.blob, cropped: true }
      }, [shot, selection])

      /** Copy (selection or whole picture), then get out of the way. */
      const copy = React.useCallback(async () => {
        try {
          if (!navigator.clipboard || typeof ClipboardItem !== 'function') throw new Error('clipboard-unavailable')
          const pickedBlob = await blobForAction()
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pickedBlob.blob })])
          // The next thing the person does is paste: get out of the way now.
          close()
        } catch (error) {
          setNotice(t('dialog.copyFailed'))
          void error
        }
      }, [blobForAction, close, t])

      /** Save through the Host so there is a real path to hand to the model. */
      const save = React.useCallback(async () => {
        setNotice(t('dialog.saving'))
        let prepared
        try {
          prepared = await blobForAction()
        } catch {
          setNotice(t('dialog.select.failed'))
          return
        }
        try {
          const file = await saveToHost(prepared.blob)
          const inserted = insertIntoComposer(inputActions, file)
          setNotice(inserted ? t('dialog.savedInserted') : file)
        } catch {
          // No Host route: fall back to the browser's own download.
          const url = URL.createObjectURL(prepared.blob)
          const link = document.createElement('a')
          link.href = url
          link.download = fileName()
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
          setNotice(t('dialog.savedDownload'))
        }
      }, [blobForAction, inputActions, t])

      // Keys mirror the browser's own tool: Enter or Ctrl+C copies, Ctrl+S
      // saves, Backspace drops the selection, Escape leaves or closes.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          const key = event.key
          if (key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (mode !== 'preview' || selection !== null) {
              setMode('preview')
              setSelection(null)
              return
            }
            close()
            return
          }
          if (key === 'Backspace' && selection !== null) {
            event.preventDefault()
            setSelection(null)
            return
          }
          if (key === 'Enter' && mode === 'preview' && phase === 'ready') {
            event.preventDefault()
            void copy()
            return
          }
          if ((event.ctrlKey || event.metaKey) && (key === 'c' || key === 'C') && phase === 'ready') {
            event.preventDefault()
            void copy()
            return
          }
          if ((event.ctrlKey || event.metaKey) && (key === 's' || key === 'S') && phase === 'ready') {
            event.preventDefault()
            void save()
            return
          }
          if (key === 'r' || key === 'R') {
            if (event.ctrlKey || event.metaKey || event.altKey) return
            event.preventDefault()
            void run('host')
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          document.body.style.overflow = previousOverflow
        }
      }, [close, copy, save, run, mode, phase, selection])

      const subline = phase === 'ready' && shot !== null
        ? t(shot.source === 'window'
          ? 'dialog.sub.window'
          : shot.source === 'browser'
            ? 'dialog.sub.browser'
            : shot.source === 'region' ? 'dialog.sub.region' : 'dialog.sub.ready')
          .replace('{w}', String(shot.width))
          .replace('{h}', String(shot.height))
        : t('dialog.sub.capturing')

      const busy = phase === 'capturing'
      const ready = phase === 'ready'
      const fullScreen = shot !== null && shot.source === 'host'

      // A light accent needs dark ink and vice versa; the token decides.
      const brandLuminance = accent === null ? null : luminanceOf(accent)
      const primaryInk = brandLuminance === null ? null : (brandLuminance > 0.55 ? '#0b0f14' : '#ffffff')

      const hoveredWindow = picked === null || hoverId === ''
        ? null
        : picked.windows.find((win) => win.id === hoverId) || null

      let noteText = ''
      if (mode === 'pick') noteText = hoveredWindow === null ? t('dialog.window.hint') : hoveredWindow.title
      else if (notice !== '') noteText = notice

      const tool = (label, onClick, options) => h('button', {
        className: 'fs-tool' + (options && options.accent ? ' fs-accent' : ''),
        type: 'button',
        onClick,
        disabled: Boolean(options && options.disabled),
        style: options && options.accent && primaryInk !== null ? { color: primaryInk } : undefined,
      }, label)

      const closeChip = h(
        'button',
        {
          className: 'fs-chip',
          type: 'button',
          title: t('dialog.close'),
          'aria-label': t('dialog.close'),
          onClick: close,
        },
        h(CloseGlyph, { size: 15 }),
      )

      let toolbar
      if (busy) {
        toolbar = h(
          'div',
          { className: 'fs-toolbar' },
          h('span', { className: 'fs-tool fs-toolDim' }, t('dialog.capturing')),
          h('span', { className: 'fs-sep' }),
          closeChip,
        )
      } else if (!ready) {
        toolbar = h(
          'div',
          { className: 'fs-toolbar' },
          tool(t('dialog.browser'), () => run('browser')),
          tool(t('dialog.retake'), () => run('host'), { accent: true }),
          h('span', { className: 'fs-sep' }),
          closeChip,
        )
      } else {
        toolbar = h(
          'div',
          { className: 'fs-toolbar' },
          selection !== null ? tool(t('dialog.select.clear'), () => setSelection(null)) : null,
          mode === 'pick'
            ? tool(t('dialog.select.clear'), () => {
              setMode('preview')
              setHoverId('')
            })
            : h(React.Fragment, null,
              fullScreen
                ? tool(t('dialog.window.start'), () => {
                  setNotice('')
                  setPicked(null)
                  setHoverId('')
                  setMode('pick')
                })
                : null,
              tool(t('dialog.retake'), () => run('host')),
              h('span', { className: 'fs-sep' }),
              tool(t('dialog.save'), save),
              tool(t('dialog.copy'), copy, { accent: true }),
            ),
          h('span', { className: 'fs-sep' }),
          closeChip,
        )
      }

      let stage
      if (phase === 'ready' && shot !== null) {
        const marquee = selection === null
          ? null
          : {
            left: Math.min(selection.x0, selection.x1) * 100 + '%',
            top: Math.min(selection.y0, selection.y1) * 100 + '%',
            width: Math.abs(selection.x1 - selection.x0) * 100 + '%',
            height: Math.abs(selection.y1 - selection.y0) * 100 + '%',
          }
        const snap = hoveredWindow === null || picked === null
          ? null
          : {
            left: ((hoveredWindow.left - picked.screen.left) / picked.screen.width) * 100 + '%',
            top: ((hoveredWindow.top - picked.screen.top) / picked.screen.height) * 100 + '%',
            width: (hoveredWindow.width / picked.screen.width) * 100 + '%',
            height: (hoveredWindow.height / picked.screen.height) * 100 + '%',
          }
        const sizeTag = selection === null || box === null
          ? null
          : {
            left: Math.min(selection.x0, selection.x1) * 100 + '%',
            top: Math.min(selection.y0, selection.y1) * 100 + '%',
            transform: 'translateY(calc(-100% - 6px))',
          }
        stage = h(
          'div',
          {
            className: 'fs-frame',
            ref: frame,
            'data-mode': mode === 'pick' ? 'pick' : 'draw',
            style: box === null ? { maxWidth: '100%', maxHeight: '100%' } : { width: box.width + 'px', height: box.height + 'px' },
            onMouseDown: beginSelection,
            onMouseMove: trackHover,
            onMouseLeave: () => {
              if (hoverId !== '') setHoverId('')
            },
          },
          h('img', {
            className: 'fs-image',
            src: shot.url,
            alt: t('dialog.title'),
            draggable: false,
            style: box === null
              ? { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }
              : { width: '100%', height: '100%', objectFit: 'fill' },
          }),
          marquee === null && snap === null ? h('div', { className: 'fs-dim' }) : null,
          marquee === null ? null : h('div', { className: 'fs-marquee', style: marquee }),
          snap === null ? null : h('div', { className: 'fs-snap', style: snap }),
          sizeTag === null
            ? null
            : h('div', { className: 'fs-sizeTag', style: sizeTag },
              t('dialog.select.size')
                .replace('{w}', String(Math.round(Math.abs(selection.x1 - selection.x0) * shot.width)))
                .replace('{h}', String(Math.round(Math.abs(selection.y1 - selection.y0) * shot.height)))),
        )
      } else if (phase === 'error') {
        stage = h(
          'div',
          { className: 'fs-center' },
          h('div', { className: 'fs-errorBox' },
            h('div', { className: 'fs-errorTitle' }, t('dialog.error.title')),
            h('div', { className: 'fs-errorBody' }, message),
          ),
        )
      } else {
        stage = h(
          'div',
          { className: 'fs-center' },
          h('div', { className: 'fs-spinner' }),
          h('div', { className: 'fs-pendingText' }, t('dialog.capturing')),
        )
      }

      return ReactDOM.createPortal(
        h(
          'div',
          { className: 'fs-overlay' },
          h('div', { className: 'fs-canvas', ref: stageRef }, stage),
          h(
            'div',
            { className: 'fs-top' },
            h('div', { className: 'fs-topText' },
              subline,
              h('span', { className: 'fs-topHint' }, t('dialog.hint')),
            ),
          ),
          noteText === '' ? null : h('div', { className: 'fs-note' }, noteText),
          toolbar,
        ),
        document.body,
      )
    }

    /** Composer-tool seat: the camera button and, while open, the overlay. */
    function ScreenshotEntry(props) {
      // The seat itself carries no translator; the registration injects this one.
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [open, setOpen] = React.useState(false)
      const trigger = React.useRef(null)
      const close = React.useCallback(() => setOpen(false), [])

      // A shortcut is the difference between "reaching for a button" and
      // "capturing": the camera is still there for discovery.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (!event.ctrlKey || !event.altKey) return
          if (event.key !== 's' && event.key !== 'S') return
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [])
      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'button',
          {
            ref: trigger,
            className: 'fs-trigger',
            type: 'button',
            title: t('action.title'),
            'aria-label': t('action.title'),
            'aria-haspopup': 'dialog',
            onClick: () => setOpen(true),
          },
          h(CameraGlyph, { size: 15 }),
          h('span', { className: 'fs-triggerLabel' }, t('action.label')),
        ),
        open
          ? h(Dialog, {
            t,
            onClose: close,
            anchor: trigger,
            inputActions: props.inputActions,
          })
          : null,
      )
    }

    // ----------------------------------------------------------------- entry

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fullscreen-shot: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'fullscreen-shot',
        order: 7,
        label: () => t('action.label'),
        inject: () => ({ t }),
      }, ScreenshotEntry))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})

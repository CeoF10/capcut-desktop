const { app, BrowserWindow, ipcMain, dialog, protocol, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { spawn, exec, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { exportProjectNatively, detectGpuEncoder } = require('./ffmpeg_export.cjs');

// Permitir reproducción inmediata de audio sin bloqueo por falta de interacción inicial
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let currentExportSession = null;

function getProbeMetadata(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], (err, stdout) => {
      if (err || !stdout) return resolve({ duration: 30, width: 1920, height: 1080, fps: 30 });
      try {
        const data = JSON.parse(stdout);
        const formatDur = parseFloat(data.format?.duration);
        const streamDur = parseFloat(data.streams?.find((s) => s.duration && parseFloat(s.duration) > 0)?.duration);
        const duration = (!isNaN(formatDur) && formatDur > 0) ? formatDur : ((!isNaN(streamDur) && streamDur > 0) ? streamDur : 30);
        const videoStream = data.streams?.find((s) => s.codec_type === 'video');
        resolve({
          duration: Math.round(duration * 100) / 100,
          width: videoStream?.width || 1920,
          height: videoStream?.height || 1080,
          fps: videoStream?.r_frame_rate ? eval(videoStream.r_frame_rate) : 30
        });
      } catch (e) {
        resolve({ duration: 30, width: 1920, height: 1080, fps: 30 });
      }
    });
  });
}

// Registrar esquema privilegiado para streaming de video/audio local
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f0f12',
    title: 'CapCut Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Permite previsualización nativa de archivos locales
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('console-message', (event, ...args) => {
    if (event && typeof event === 'object' && event.message !== undefined) {
      console.log(`[RENDERER ${event.level}]:`, event.message, event.sourceId ? `(${event.sourceId}:${event.lineNumber})` : '');
    } else {
      console.log('[RENDERER]:', event, ...args);
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[RENDERER PROCESS GONE]:', details);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const distPath = path.join(__dirname, '../dist/index.html');

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(() => {
  // Protocolo personalizado para reproducir archivos locales si alguna ruta aún usa media://
  protocol.handle('media', (request) => {
    try {
      const rawPath = request.url.replace(/^media:\/\//, '');
      const filePath = decodeURIComponent(rawPath.startsWith('/') ? rawPath : '/' + rawPath);
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = request.headers.get('range');
      const ext = path.extname(filePath).toLowerCase();

      const mimeType = ext === '.mp3' ? 'audio/mpeg' :
                       ext === '.wav' ? 'audio/wav' :
                       ext === '.ogg' ? 'audio/ogg' :
                       ext === '.m4a' || ext === '.aac' ? 'audio/mp4' :
                       ext === '.mp4' ? 'video/mp4' :
                       ext === '.webm' ? 'video/webm' :
                       ext === '.png' ? 'image/png' :
                       ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                       'application/octet-stream';

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        const webStream = Readable.toWeb(nodeStream);

        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': mimeType
          }
        });
      } else {
        const nodeStream = fs.createReadStream(filePath);
        const webStream = Readable.toWeb(nodeStream);
        return new Response(webStream, {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(fileSize),
            'Content-Type': mimeType
          }
        });
      }
    } catch (err) {
      console.error('Error cargando media local con esquema media://:', err);
      return new Response('Error', { status: 500 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Abrir explorador de archivos
ipcMain.handle('dialog:openFiles', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleccionar videos, fotos o audios',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Archivos Multimedia',
        extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac']
      },
      { name: 'Videos', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
      { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'Audios', extensions: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'] }
    ]
  });

  if (result.canceled) return [];

  const filesData = await Promise.all(
    result.filePaths.map(async (filePath) => {
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      let type = 'video';
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) type = 'image';
      if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'].includes(ext)) type = 'audio';

      const stats = fs.statSync(filePath);
      const meta = (type === 'video' || type === 'audio') ? await getProbeMetadata(filePath) : { duration: 3 };

      return {
        id: 'media_' + Math.random().toString(36).substring(2, 9),
        name: path.basename(filePath),
        path: filePath,
        url: pathToFileURL(filePath).href,
        type,
        size: stats.size,
        duration: meta.duration || (type === 'image' ? 3 : 30)
      };
    })
  );

  return filesData;
});

// IPC: Guardar archivo MP4 dialog
ipcMain.handle('dialog:saveFile', async (event, defaultName = 'mi_video_capcut.mp4') => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar Video',
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [{ name: 'Video MP4', extensions: ['mp4'] }]
  });
  return result.canceled ? null : result.filePath;
});

// IPC: Obtener metadatos reales con FFprobe
ipcMain.handle('media:getMetadata', async (event, filePath) => {
  return getProbeMetadata(filePath);
});

// Cache en memoria para formas de onda de audio
const waveformCache = new Map();

// IPC: Extraer ondas de sonido (waveform) de audio o video
ipcMain.handle('media:getWaveform', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return [];
  if (waveformCache.has(filePath)) return waveformCache.get(filePath);

  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve([]);
    // Extraer audio mono remuestreado a 20Hz en float32
    const proc = spawn('ffmpeg', [
      '-v', 'quiet',
      '-i', filePath,
      '-ac', '1',
      '-ar', '20',
      '-f', 'f32le',
      'pipe:1'
    ]);

    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));

    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) return resolve([]);
      const buf = Buffer.concat(chunks);
      const numSamples = Math.floor(buf.length / 4);
      if (numSamples === 0) return resolve([]);

      let maxVal = 0.0001;
      const raw = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        const val = Math.abs(buf.readFloatLE(i * 4));
        raw[i] = val;
        if (val > maxVal) maxVal = val;
      }

      // Normalizar picos entre 0.0 y 1.0 con compresión dinámica suave para mejor visualización
      const normalized = new Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        const ratio = raw[i] / maxVal;
        // Aplicar curva logarítmica/raíz cuadrada ligera para resaltar partes suaves sin saturar
        normalized[i] = Math.round(Math.pow(ratio, 0.7) * 100) / 100;
      }

      waveformCache.set(filePath, normalized);
      resolve(normalized);
    });

    proc.on('error', () => resolve([]));
  });
});

// IPC: Extraer thumbnail
ipcMain.handle('media:extractThumbnail', async (event, filePath) => {
  return new Promise((resolve) => {
    const tmpThumb = path.join(app.getPath('temp'), `thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
    const cmd = `ffmpeg -y -ss 00:00:01 -i "${filePath}" -vframes 1 -q:v 3 -vf "scale=320:-1" "${tmpThumb}"`;
    exec(cmd, (err) => {
      if (err || !fs.existsSync(tmpThumb)) {
        return resolve(null);
      }
      try {
        const base64 = fs.readFileSync(tmpThumb).toString('base64');
        fs.unlinkSync(tmpThumb);
        resolve(`data:image/jpeg;base64,${base64}`);
      } catch (e) {
        resolve(null);
      }
    });
  });
});

// IPC: Subtítulos automáticos con Python + Whisper
ipcMain.handle('subtitles:transcribe', async (event, { filePath, model = 'base', language = 'es' }) => {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '../python/transcribe.py');
    const venvPython = path.join(__dirname, '../python/venv/bin/python');
    const pythonExe = fs.existsSync(venvPython) ? `"${venvPython}"` : 'python3';
    const cmd = `${pythonExe} "${scriptPath}" --input "${filePath}" --model "${model}" --language "${language}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (stdout) {
        try {
          const res = JSON.parse(stdout.trim());
          return resolve(res);
        } catch (e) {
          // parse error
        }
      }
      resolve({
        status: 'error',
        message: err ? err.message : 'Error al transcribir el audio con Whisper.'
      });
    });
  });
});

// IPC: Exportación de video nativa ultrarrápida con FFmpeg
ipcMain.handle('export:start', async (event, options) => {
  return new Promise((resolve, reject) => {
    try {
      if (currentExportSession) {
        currentExportSession.cancel();
        currentExportSession = null;
      }

      currentExportSession = exportProjectNatively(
        options,
        (progress) => {
          if (mainWindow) mainWindow.webContents.send('export:progress', progress);
        },
        (outputPath) => {
          if (mainWindow) mainWindow.webContents.send('export:completed', outputPath);
          currentExportSession = null;
          resolve({ status: 'completed', outputPath });
        },
        (error) => {
          if (mainWindow) mainWindow.webContents.send('export:error', error.message);
          currentExportSession = null;
          reject(error);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
});

ipcMain.handle('export:frame', async () => true);
ipcMain.handle('export:finish', async () => true);

ipcMain.handle('export:cancel', async () => {
  if (currentExportSession) {
    currentExportSession.cancel();
    currentExportSession = null;
  }
  return true;
});

ipcMain.handle('shell:showItemInFolder', (event, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

// IPC: Información de aceleración por GPU
ipcMain.handle('system:getGpuInfo', async () => {
  return detectGpuEncoder();
});

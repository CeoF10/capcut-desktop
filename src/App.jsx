import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import HomeScreen from './components/HomeScreen';
import Navbar from './components/Navbar';
import MediaPanel from './components/MediaPanel';
import CanvasPlayer from './components/CanvasPlayer';
import Timeline from './components/Timeline';
import PropertiesPanel from './components/PropertiesPanel';
import AutoSubtitleModal from './components/AutoSubtitleModal';
import ExportModal from './components/ExportModal';
import { SUBTITLE_THEMES, SUBTITLE_BG_MODES } from './utils/presets';

const DEFAULT_PROJECTS = [
  {
    id: 'proj_demo_1',
    name: 'Mi Primer Video CapCut',
    aspectRatio: '16:9',
    updatedAt: new Date().toISOString(),
    mediaPool: [],
    tracks: [
      { id: 'track_1', name: 'Pista 1', clips: [] },
      { id: 'track_2', name: 'Pista 2', clips: [] },
      { id: 'track_3', name: 'Pista 3', clips: [] }
    ],
    totalDuration: 10,
    clipCount: 0
  }
];

export function normalizeMediaUrl(url, filePath) {
  if (url && typeof url === 'string') {
    if (url.startsWith('file://')) return url;
    if (url.startsWith('media://')) {
      const raw = url.replace(/^media:\/\//, '');
      const decoded = decodeURIComponent(raw.startsWith('/') ? raw : '/' + raw);
      return 'file://' + decoded;
    }
  }
  if (filePath && typeof filePath === 'string') {
    return 'file://' + (filePath.startsWith('/') ? filePath : '/' + filePath);
  }
  return url || '';
}

export function sanitizeProject(p) {
  if (!p) return p;

  const rawTracks = (p.tracks || []).map((t) => ({
    ...t,
    clips: (t.clips || []).map((c) => ({
      ...c,
      url: normalizeMediaUrl(c.url, c.path),
      positionY: (c.type === 'text' && c.isSubtitle && (!c.positionY || c.positionY === 82)) ? 87 : c.positionY
    }))
  }));

  // Si alguna pista contiene tanto videos como imágenes, separar las imágenes en su propia pista de superposición
  const newTracks = [];
  const extractedImages = [];

  rawTracks.forEach((t) => {
    const hasVideo = t.clips.some((c) => c.type === 'video');
    const hasImage = t.clips.some((c) => c.type === 'image');

    if (hasVideo && hasImage) {
      const remainingClips = t.clips.filter((c) => c.type !== 'image');
      const imgClips = t.clips.filter((c) => c.type === 'image');
      newTracks.push({ ...t, clips: remainingClips });
      extractedImages.push(...imgClips);
    } else {
      newTracks.push(t);
    }
  });

  if (extractedImages.length > 0) {
    newTracks.push({
      id: 'track_' + Date.now() + '_overlay',
      name: 'Pista Superposición (Fotos / Logos)',
      muted: false,
      hidden: false,
      clips: extractedImages
    });
  }

  // Asegurar al menos 2 pistas para comodidad visual
  if (newTracks.length === 1) {
    newTracks.push({
      id: 'track_' + Date.now() + '_2',
      name: 'Pista 2 (Superposición)',
      muted: false,
      hidden: false,
      clips: []
    });
  }

  return {
    ...p,
    mediaPool: (p.mediaPool || []).map((m) => ({
      ...m,
      url: normalizeMediaUrl(m.url, m.path)
    })),
    tracks: newTracks
  };
}

export default function App() {
  // Modo de vista: 'home' (Hub de proyectos) o 'editor' (Área de trabajo)
  const [viewMode, setViewMode] = useState('home');

  // Lista de proyectos almacenados en localStorage con sanitización automática de URLs locales
  const [projects, setProjects] = useState(() => {
    try {
      const saved = localStorage.getItem('capcut_projects_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed.map(sanitizeProject);
      }
    } catch (e) {}
    return DEFAULT_PROJECTS;
  });

  // Proyecto activo en edición
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [projectName, setProjectName] = useState('Proyecto sin título');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [mediaPool, setMediaPool] = useState([]);
  const [tracks, setTracks] = useState([
    { id: 'track_1', name: 'Pista 1', clips: [] },
    { id: 'track_2', name: 'Pista 2', clips: [] },
    { id: 'track_3', name: 'Pista 3', clips: [] }
  ]);

  // Navegación interna del editor
  const [activeTab, setActiveTab] = useState('media');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(60);
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [activeThemeId, setActiveThemeId] = useState('theme_blue_electric');
  const [activeBgMode, setActiveBgMode] = useState('black');

  // Historial de cambios para Deshacer / Rehacer (Undo / Redo)
  const [history, setHistory] = useState({
    past: [],
    future: []
  });

  const updateTracks = useCallback((action, addToHistory = true) => {
    setTracks((prevTracks) => {
      const nextTracks = typeof action === 'function' ? action(prevTracks) : action;
      if (addToHistory && nextTracks !== prevTracks) {
        setHistory((prevHist) => ({
          past: [...prevHist.past.slice(-30), prevTracks],
          future: []
        }));
      }
      return nextTracks;
    });
  }, []);

  const handleUndo = useCallback(() => {
    setHistory((prevHist) => {
      if (prevHist.past.length === 0) return prevHist;
      const previous = prevHist.past[prevHist.past.length - 1];
      const newPast = prevHist.past.slice(0, -1);

      setTracks((currentTracks) => {
        setHistory((h) => ({
          past: newPast,
          future: [currentTracks, ...h.future]
        }));
        return previous;
      });

      return prevHist;
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((prevHist) => {
      if (prevHist.future.length === 0) return prevHist;
      const nextState = prevHist.future[0];
      const newFuture = prevHist.future.slice(1);

      setTracks((currentTracks) => {
        setHistory((h) => ({
          past: [...h.past, currentTracks],
          future: newFuture
        }));
        return nextState;
      });

      return prevHist;
    });
  }, []);

  // Atajos globales Ctrl+Z y Ctrl+Y
  useEffect(() => {
    const handleUndoRedoKeys = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleUndoRedoKeys);
    return () => window.removeEventListener('keydown', handleUndoRedoKeys);
  }, [handleUndo, handleRedo]);

  // Modales
  const [isSubtitleModalOpen, setIsSubtitleModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  const canvasRef = useRef(null);

  // Guardar proyectos en localStorage automáticamente
  useEffect(() => {
    try {
      localStorage.setItem('capcut_projects_v2', JSON.stringify(projects));
    } catch (e) {}
  }, [projects]);

  // Calcular duración total dinámicamente
  const totalDuration = useMemo(() => {
    let maxTime = 10;
    tracks.forEach((track) => {
      track.clips.forEach((c) => {
        maxTime = Math.max(maxTime, c.start + c.duration);
      });
    });
    return Math.round(maxTime * 100) / 100;
  }, [tracks]);

  // Total de clips en el proyecto
  const totalClipCount = useMemo(() => {
    return tracks.reduce((acc, t) => acc + t.clips.length, 0);
  }, [tracks]);

  // Guardar cambios del proyecto activo
  useEffect(() => {
    if (viewMode === 'editor' && currentProjectId) {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== currentProjectId) return p;
          return {
            ...p,
            name: projectName,
            aspectRatio,
            mediaPool,
            tracks,
            totalDuration,
            clipCount: totalClipCount,
            updatedAt: new Date().toISOString()
          };
        })
      );
    }
  }, [projectName, aspectRatio, mediaPool, tracks, totalDuration, totalClipCount, viewMode, currentProjectId]);

  // Crear nuevo proyecto
  const handleNewProject = (ratio = '16:9', openSubtitles = false) => {
    const newId = 'proj_' + Date.now();
    const newProj = {
      id: newId,
      name: `Proyecto ${ratio === '9:16' ? 'TikTok' : 'Video'} ${projects.length + 1}`,
      aspectRatio: ratio,
      updatedAt: new Date().toISOString(),
      mediaPool: [],
      tracks: [
        { id: `track_${Date.now()}_1`, name: 'Pista 1', clips: [] },
        { id: `track_${Date.now()}_2`, name: 'Pista 2', clips: [] },
        { id: `track_${Date.now()}_3`, name: 'Pista 3', clips: [] }
      ],
      totalDuration: 10,
      clipCount: 0
    };

    setProjects([newProj, ...projects]);
    setCurrentProjectId(newId);
    setProjectName(newProj.name);
    setAspectRatio(newProj.aspectRatio);
    setMediaPool([]);
    setTracks(newProj.tracks);
    setCurrentTime(0);
    setIsPlaying(false);
    setSelectedClipId(null);
    setViewMode('editor');

    if (openSubtitles) {
      setTimeout(() => setIsSubtitleModalOpen(true), 250);
    }
  };

  // Abrir proyecto existente
  const handleOpenProject = (id) => {
    const rawProj = projects.find((p) => p.id === id);
    if (!rawProj) return;
    const proj = sanitizeProject(rawProj);

    setCurrentProjectId(proj.id);
    setProjectName(proj.name);
    setAspectRatio(proj.aspectRatio || '16:9');
    setMediaPool(proj.mediaPool || []);
    setTracks(
      proj.tracks && proj.tracks.length > 0
        ? proj.tracks
        : [
            { id: `track_${Date.now()}_1`, name: 'Pista 1', clips: [] },
            { id: `track_${Date.now()}_2`, name: 'Pista 2', clips: [] }
          ]
    );
    setCurrentTime(0);
    setIsPlaying(false);
    setSelectedClipId(null);
    setViewMode('editor');
  };

  // Duplicar proyecto
  const handleDuplicateProject = (id) => {
    const proj = projects.find((p) => p.id === id);
    if (!proj) return;

    const dup = {
      ...proj,
      id: 'proj_' + Date.now(),
      name: `${proj.name} (Copia)`,
      updatedAt: new Date().toISOString()
    };
    setProjects([dup, ...projects]);
  };

  // Eliminar proyecto
  const handleDeleteProject = (id) => {
    setProjects(projects.filter((p) => p.id !== id));
  };

  // Volver a la pantalla de proyectos
  const handleGoHome = () => {
    setIsPlaying(false);
    setViewMode('home');
  };

  // Importar archivos multimedia
  const handleImportFiles = async () => {
    if (window.capcutAPI?.openFiles) {
      try {
        const files = await window.capcutAPI.openFiles();
        if (files && files.length > 0) {
          const processedFiles = await Promise.all(
            files.map(async (file) => {
              let duration = file.duration || (file.type === 'image' ? 3 : 30);
              let thumbnail = null;

              if (file.type === 'video') {
                const meta = await window.capcutAPI.getMediaMetadata(file.path);
                if (meta && meta.duration) duration = meta.duration;
                thumbnail = await window.capcutAPI.extractThumbnail(file.path);
              } else if (file.type === 'audio') {
                const meta = await window.capcutAPI.getMediaMetadata(file.path);
                if (meta && meta.duration) duration = meta.duration;
              } else if (file.type === 'image') {
                thumbnail = normalizeMediaUrl(file.url, file.path);
              }

              return {
                ...file,
                url: normalizeMediaUrl(file.url, file.path),
                duration,
                thumbnail
              };
            })
          );
          setMediaPool((prev) => [...prev, ...processedFiles]);
        }
      } catch (err) {
        console.error('Error importando archivos:', err);
      }
    } else {
      const mockItem = {
        id: 'mock_' + Date.now(),
        name: 'Video_Demo_CapCut.mp4',
        type: 'video',
        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        path: '/sample/BigBuckBunny.mp4',
        duration: 15.0,
        thumbnail: null
      };
      setMediaPool((prev) => [...prev, mockItem]);
    }
  };

  // Actualizar automáticamente la duración real de un clip cuando el navegador carga metadatos
  const handleUpdateClipDuration = (clipId, newDuration) => {
    if (!newDuration || isNaN(newDuration) || newDuration <= 0) return;
    const rounded = Math.round(newDuration * 100) / 100;
    setTracks((prevTracks) => {
      let changed = false;
      const next = prevTracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (Math.abs(c.duration - rounded) < 0.1) return c;
          changed = true;
          return { ...c, duration: rounded };
        })
      }));
      return changed ? next : prevTracks;
    });
  };

  // Añadir medio a cualquiera de las pistas universales (con pegado automático y pista de superposición)
  const handleAddMediaToTimeline = (mediaItem) => {
    const clipDuration = (mediaItem.duration && mediaItem.duration > 0)
      ? mediaItem.duration
      : (mediaItem.type === 'image' ? 5.0 : 30);

    let finalStart = Math.round(currentTime * 100) / 100;

    setTracks((prevTracks) => {
      let workingTracks = [...prevTracks];

      if (workingTracks.length === 0) {
        workingTracks = [{ id: 'track_1', name: 'Pista 1', clips: [] }];
      }

      // Determinar pista destino:
      // Audio -> última pista
      // Video -> pista 0
      // Imagen -> Si alguna pista ya tiene videos, colocar la imagen en una pista de superposición
      let targetTrackIndex = 0;
      if (mediaItem.type === 'audio') {
        targetTrackIndex = workingTracks.length > 1 ? workingTracks.length - 1 : 0;
      } else if (mediaItem.type === 'image') {
        const hasVideo = workingTracks.some((t) => t.clips.some((c) => c.type === 'video'));
        if (hasVideo) {
          let freeTrackIdx = workingTracks.findIndex((t) => !t.clips.some((c) => c.type === 'video'));
          if (freeTrackIdx === -1) {
            workingTracks.push({
              id: 'track_' + Date.now() + '_overlay',
              name: `Pista ${workingTracks.length + 1} (Superposición)`,
              muted: false,
              hidden: false,
              clips: []
            });
            freeTrackIdx = workingTracks.length - 1;
          }
          targetTrackIndex = freeTrackIdx;
        }
      }

      const targetTrack = workingTracks[targetTrackIndex] || workingTracks[0];

      if (targetTrack && targetTrack.clips.length > 0 && mediaItem.type !== 'image') {
        const lastClipEnd = targetTrack.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
        // Pegado automático: si está cerca del final o al final del proyecto, pegar al final del último clip
        if (Math.abs(finalStart - lastClipEnd) < 0.6 || finalStart >= lastClipEnd) {
          finalStart = Math.round(lastClipEnd * 100) / 100;
        } else {
          // Si está cerca del final de algún clip intermedio, pegar a ese clip
          for (const c of targetTrack.clips) {
            const cEnd = c.start + c.duration;
            if (Math.abs(finalStart - cEnd) < 0.4) {
              finalStart = Math.round(cEnd * 100) / 100;
              break;
            }
          }
        }
      }

      // Si es una imagen colocada en modo superposición sobre video, escala por defecto elegante (0.45 = 45%) para no tapar la pantalla
      const isOverlayImage = mediaItem.type === 'image';
      const defaultScale = isOverlayImage ? 0.45 : 1;

      const newClip = {
        id: 'clip_' + Date.now() + '_' + Math.random().toString(36).substring(7),
        mediaId: mediaItem.id,
        name: mediaItem.name,
        type: mediaItem.type,
        path: mediaItem.path,
        url: normalizeMediaUrl(mediaItem.url, mediaItem.path),
        thumbnail: mediaItem.thumbnail || (mediaItem.type === 'image' ? normalizeMediaUrl(mediaItem.url, mediaItem.path) : null),
        start: finalStart,
        duration: clipDuration,
        offset: 0,
        opacity: 1,
        scale: defaultScale,
        posX: 0,
        posY: 0,
        volume: 1
      };

      setSelectedClipId(newClip.id);
      setCurrentTime(Math.round((finalStart + clipDuration) * 100) / 100);

      return workingTracks.map((t, idx) => {
        if (idx === targetTrackIndex) {
          return { ...t, clips: [...t.clips, newClip] };
        }
        return t;
      });
    });
  };

  // Añadir texto a las pistas universales (con pegado automático)
  const handleAddTextToTimeline = (preset = null) => {
    let finalStart = Math.round(currentTime * 100) / 100;
    const duration = 3.0;

    setTracks((prevTracks) => {
      const targetTrack = prevTracks[0];
      if (targetTrack && targetTrack.clips.length > 0) {
        for (const c of targetTrack.clips) {
          const cEnd = c.start + c.duration;
          if (Math.abs(finalStart - cEnd) < 0.4) {
            finalStart = Math.round(cEnd * 100) / 100;
            break;
          }
        }
      }

      const newText = {
        id: 'text_' + Date.now() + '_' + Math.random().toString(36).substring(7),
        type: 'text',
        text: preset ? preset.text : 'Tu Texto Aquí',
        start: finalStart,
        duration: duration,
        fontSize: preset ? preset.fontSize : 42,
        color: preset ? preset.color : '#FFFFFF',
        bgColor: preset ? preset.bgColor : 'transparent',
        fontFamily: preset ? preset.fontFamily : 'system-ui, sans-serif',
        strokeColor: preset ? preset.strokeColor : '#000000',
        strokeWidth: preset ? preset.strokeWidth : 2,
        positionY: preset ? preset.positionY : 50,
        isSubtitle: false
      };

      setSelectedClipId(newText.id);

      if (prevTracks.length === 0) {
        return [{ id: 'track_1', name: 'Pista 1', clips: [newText] }];
      }
      return prevTracks.map((t, idx) => {
        if (idx === 0) {
          return { ...t, clips: [...t.clips, newText] };
        }
        return t;
      });
    });
  };

  // Eliminar de biblioteca
  const handleDeleteMedia = (mediaId) => {
    setMediaPool((prev) => prev.filter((m) => m.id !== mediaId));
  };

  // Aplicar tema de subtítulo viral (TikTok Azul, Amarillo, etc.) con el modo de fondo activo o especificado
  const handleApplySubtitleTheme = (theme, bgMode = activeBgMode) => {
    setActiveThemeId(theme.id);
    const bgConfig = SUBTITLE_BG_MODES.find((b) => b.id === bgMode) || SUBTITLE_BG_MODES[0];
    setTracks((prevTracks) =>
      prevTracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.type !== 'text' || !c.isSubtitle) return c;
          return {
            ...c,
            color: bgConfig.baseColor,
            highlightColor: theme.highlightColor,
            bgColor: bgConfig.bgColor,
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
            strokeColor: bgConfig.strokeColor,
            strokeWidth: bgConfig.strokeWidth,
            positionY: theme.positionY,
            uppercase: theme.uppercase ?? c.uppercase ?? true,
            karaoke: true
          };
        })
      }))
    );
  };

  // Cambiar modo de fondo para todos los subtítulos (Negro, Blanco fácil lectura, Transparente, Azul noche)
  const handleChangeBgMode = (newBgMode) => {
    setActiveBgMode(newBgMode);
    const activeTheme = SUBTITLE_THEMES.find((th) => th.id === activeThemeId) || SUBTITLE_THEMES[0];
    handleApplySubtitleTheme(activeTheme, newBgMode);
  };

  // Aplicar subtítulos automáticos con el tema viral activo y el modo de fondo seleccionado
  const handleApplySubtitles = (generatedSubtitles) => {
    const activeTheme = SUBTITLE_THEMES.find((th) => th.id === activeThemeId) || SUBTITLE_THEMES[0];
    const bgConfig = SUBTITLE_BG_MODES.find((b) => b.id === activeBgMode) || SUBTITLE_BG_MODES[0];

    const universalSubClips = generatedSubtitles.map((sub) => ({
      ...sub,
      type: 'text',
      isSubtitle: true,
      karaoke: true,
      words: sub.words || [],
      color: bgConfig.baseColor,
      highlightColor: activeTheme.highlightColor,
      bgColor: bgConfig.bgColor,
      fontFamily: activeTheme.fontFamily,
      fontSize: activeTheme.fontSize,
      strokeColor: bgConfig.strokeColor,
      strokeWidth: bgConfig.strokeWidth,
      positionY: activeTheme.positionY,
      uppercase: activeTheme.uppercase !== undefined ? activeTheme.uppercase : true
    }));

    // Insertar en la primera pista
    setTracks((prevTracks) => {
      if (prevTracks.length === 0) {
        return [{ id: 'track_1', name: 'Pista 1', clips: universalSubClips }];
      }
      return prevTracks.map((t, idx) => {
        if (idx === 0) {
          return { ...t, clips: [...t.clips, ...universalSubClips] };
        }
        return t;
      });
    });

    setActiveTab('subtitles');
  };

  // Subtítulos activos
  const allSubtitles = useMemo(() => {
    return tracks.flatMap((t) => t.clips.filter((c) => c.type === 'text' && c.isSubtitle));
  }, [tracks]);

  const handleSelectSubtitle = (sub) => {
    setSelectedClipId(sub.id);
    setCurrentTime(sub.start);
  };

  // 1. Si estamos en modo 'home', mostrar Hub de Proyectos
  if (viewMode === 'home') {
    return (
      <HomeScreen
        projects={projects}
        onNewProject={handleNewProject}
        onOpenProject={handleOpenProject}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
      />
    );
  }

  // 2. Si estamos en modo 'editor', mostrar CapCut Desktop Editor
  return (
    <div className="w-screen h-screen flex flex-col bg-[#0e0e11] text-gray-100 overflow-hidden font-sans">
      {/* Barra Superior con botón para volver a Proyectos */}
      <Navbar
        projectName={projectName}
        setProjectName={setProjectName}
        currentTime={currentTime}
        totalDuration={totalDuration}
        isPlaying={isPlaying}
        setIsPlaying={setIsPlaying}
        aspectRatio={aspectRatio}
        setAspectRatio={setAspectRatio}
        onOpenAutoSubtitles={() => setIsSubtitleModalOpen(true)}
        onOpenExport={() => setIsExportModalOpen(true)}
        onGoHome={handleGoHome}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />

      {/* Área Central: Medios + Reproductor Canvas + Inspector */}
      <div className="flex-1 flex overflow-hidden">
        <MediaPanel
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          mediaPool={mediaPool}
          onImportFiles={handleImportFiles}
          onAddMediaToTimeline={handleAddMediaToTimeline}
          onAddTextToTimeline={handleAddTextToTimeline}
          onDeleteMedia={handleDeleteMedia}
          subtitles={allSubtitles}
          onOpenAutoSubtitles={() => setIsSubtitleModalOpen(true)}
          onSelectSubtitle={handleSelectSubtitle}
          onApplySubtitleTheme={handleApplySubtitleTheme}
          activeThemeId={activeThemeId}
          activeBgMode={activeBgMode}
          onChangeBgMode={handleChangeBgMode}
          currentTime={currentTime}
        />

        <CanvasPlayer
          currentTime={currentTime}
          setCurrentTime={setCurrentTime}
          totalDuration={totalDuration}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          aspectRatio={aspectRatio}
          tracks={tracks}
          canvasRef={canvasRef}
          onUpdateClipDuration={handleUpdateClipDuration}
        />

        <PropertiesPanel
          selectedClipId={selectedClipId}
          tracks={tracks}
          setTracks={updateTracks}
          totalDuration={totalDuration}
          aspectRatio={aspectRatio}
        />
      </div>

      {/* Línea de Tiempo: Pistas Universales con soporte libre para Video, Audio, Fotos y Texto */}
      <Timeline
        currentTime={currentTime}
        setCurrentTime={setCurrentTime}
        totalDuration={totalDuration}
        tracks={tracks}
        setTracks={updateTracks}
        selectedClipId={selectedClipId}
        setSelectedClipId={setSelectedClipId}
        zoom={zoom}
        setZoom={setZoom}
      />

      {/* Modales */}
      <AutoSubtitleModal
        isOpen={isSubtitleModalOpen}
        onClose={() => setIsSubtitleModalOpen(false)}
        mediaPool={mediaPool}
        onApplySubtitles={handleApplySubtitles}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        totalDuration={totalDuration}
        aspectRatio={aspectRatio}
        tracks={tracks}
        canvasRef={canvasRef}
      />
    </div>
  );
}

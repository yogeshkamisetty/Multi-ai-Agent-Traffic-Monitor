import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, Play, RotateCcw, Zap, StopCircle, Camera, Video, Layers, MapPin, Database, LocateFixed, Film, Loader2, AlertCircle, X, ScanEye, Home, ChevronLeft, LayoutDashboard, History as HistoryIcon, Download } from 'lucide-react';
import { AgentPipeline } from './components/AgentPipeline';
import { ResultsDashboard } from './components/ResultsDashboard';
import { analyzeTrafficImage, getLocationContext } from './services/geminiService';
import { ObjectTracker } from './services/trackingService';
import { AgentStatus, FullAnalysisResult, HistoryItem, LocationContextData, Violation } from './types';

const SAMPLE_IMAGES = [
  "https://images.unsplash.com/photo-1566008885218-90abf9200ddb?q=80&w=1000&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1502877338535-766e1452684a?q=80&w=1000&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1597762139711-8a5a0642219c?q=80&w=1000&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1545173168-9f1947eebb8f?q=80&w=1000&auto=format&fit=crop"
];

// Reusable Error Banner Component
const ErrorBanner = ({ message, onDismiss }: { message: string, onDismiss: () => void }) => (
  <div className="bg-red-950/40 border border-red-500/50 rounded-lg p-4 mb-6 flex items-start gap-3 animate-fadeIn">
    <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
    <div className="flex-1">
      <h4 className="text-red-300 font-bold text-sm mb-1">System Alert</h4>
      <p className="text-red-200/80 text-sm leading-relaxed">{message}</p>
    </div>
    <button 
      onClick={onDismiss}
      className="text-red-400 hover:text-red-200 transition-colors p-1"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);

type ViewState = 'home' | 'monitor' | 'history';

export default function App() {
  // Navigation State
  const [activeView, setActiveView] = useState<ViewState>('home');
  const [lastView, setLastView] = useState<ViewState>('home');

  const [status, setStatus] = useState<AgentStatus>(AgentStatus.IDLE);
  const [image, setImage] = useState<string | null>(null);
  const [result, setResult] = useState<FullAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  // Modes & Queue
  const [processingQueue, setProcessingQueue] = useState<File[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  
  // Video Processing State
  const [processingVideo, setProcessingVideo] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoSessionData, setVideoSessionData] = useState<FullAnalysisResult[]>([]);
  
  // Refs
  const simulationRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null); // For capture
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null); // For drawing boxes
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoProcessingRef = useRef<boolean>(false);
  
  // Tracking Service Ref
  const trackerRef = useRef<ObjectTracker>(new ObjectTracker());

  const isMonitorActive = !!(image || isSimulating || isCameraActive || processingVideo);

  // Load History from DB (LocalStorage)
  useEffect(() => {
    const saved = localStorage.getItem('multi_ai_agent_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  // Save History to DB (LocalStorage)
  useEffect(() => {
    if (history.length > 0) {
      localStorage.setItem('multi_ai_agent_history', JSON.stringify(history));
    }
  }, [history]);

  // Effect to redraw detections when a static result is loaded (e.g. from history)
  useEffect(() => {
    if (result && image && activeView === 'monitor' && !isCameraActive && !processingVideo && !isSimulating) {
        // Small timeout to ensure the image element is sized correctly in the DOM
        const timer = setTimeout(() => {
            if (result.detections) {
                drawDetections(result.detections);
            }
        }, 100);
        return () => clearTimeout(timer);
    }
  }, [result, image, activeView, isCameraActive, processingVideo, isSimulating]);

  // Navigation Helpers
  const navigateTo = (view: ViewState) => {
    setLastView(activeView);
    setActiveView(view);
  };

  const goBack = () => {
    setActiveView(lastView);
  };

  const goHome = () => {
    stopAllModes();
    setActiveView('home');
  };

  // Handle Loading History Item
  const handleLoadHistoryItem = (item: HistoryItem) => {
    stopAllModes();
    // Use a small timeout to ensure state clears before setting new state
    setTimeout(() => {
        setImage(item.thumbnail);
        setResult(item);
        setStatus(AgentStatus.COMPLETE);
        navigateTo('monitor');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 10);
  };

  // Handle File Uploads (Image, Multiple Images, or Video)
  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    stopAllModes();
    setError(null);
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList: File[] = Array.from(files);

    // Check for video
    const videoFile = fileList.find(f => f.type.startsWith('video/'));
    
    if (videoFile) {
      handleVideoUpload(videoFile);
    } else if (fileList.length > 0) {
      // Batch Image Processing
      setProcessingQueue(fileList);
      setIsProcessingQueue(true);
      processNextInQueue(fileList);
    }
    navigateTo('monitor');
  };

  const handleVideoUpload = (file: File) => {
    const url = URL.createObjectURL(file);
    setImage(null); // We don't show a static image for video
    setProcessingVideo(true);
    videoProcessingRef.current = true;
    setVideoSessionData([]); // Reset video session tracking
    trackerRef.current.reset(); // Reset tracker
    setError(null);
    
    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.load();
      // Wait for metadata to load before starting processing loop
      videoRef.current.onloadedmetadata = () => {
        processVideoSequence();
      };
      videoRef.current.onerror = () => {
        setError("Failed to load video file. The format might be unsupported.");
        setProcessingVideo(false);
      };
    }
  };

  // Video Processing Logic (Seek -> Capture -> Analyze -> Repeat)
  const processVideoSequence = async () => {
    if (!videoRef.current || !videoProcessingRef.current) return;

    const video = videoRef.current;
    const FRAME_INTERVAL = 1.0; // Analyze 1 frame every 1 second of video (1 FPS)
    let currentTime = 0;

    const processNextFrame = async () => {
      if (!videoProcessingRef.current || currentTime > video.duration) {
        setProcessingVideo(false);
        videoProcessingRef.current = false;
        setStatus(AgentStatus.COMPLETE);
        clearOverlay(); // Clear boxes when done
        return;
      }

      // Update UI Progress
      setVideoProgress((currentTime / video.duration) * 100);
      
      // Seek to time
      video.currentTime = currentTime;
      
      // Wait for seek to complete
      await new Promise<void>(resolve => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
      });

      // Capture Frame
      const frameData = captureFrame(video);
      if (frameData) {
        // Video processing doesn't throw major UI errors, it just logs them to console to avoid interruption
        try {
          await processImage(frameData.data, frameData.mime, 'video');
        } catch (e: any) {
          console.warn("Skipped frame due to error", e);
          // If Rate Limit, pause for 5s
          if (e.message && (e.message.includes("Rate Limit") || e.message.includes("429"))) {
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      // Advance cursor
      currentTime += FRAME_INTERVAL;
      
      // Continue loop
      requestAnimationFrame(processNextFrame);
    };

    // Start the loop
    processNextFrame();
  };

  const captureFrame = (video: HTMLVideoElement) => {
    if (!canvasRef.current) return null;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    
    ctx.drawImage(video, 0, 0);
    const base64DataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const matches = base64DataUrl.match(/^data:(.+);base64,(.+)$/);
    if (matches) {
      return { mime: matches[1], data: matches[2] };
    }
    return null;
  };

  // Batch Processing Logic
  const processNextInQueue = async (queue: File[]) => {
    if (queue.length === 0) {
      setIsProcessingQueue(false);
      return;
    }

    const currentFile = queue[0];
    const remaining = queue.slice(1);
    setProcessingQueue(remaining);

    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;
      setImage(base64);
      trackerRef.current.reset(); // Reset for new file
      const matches = base64.match(/^data:(.+);base64,(.+)$/);
      if (matches) {
        try {
          await processImage(matches[2], matches[1], 'single');
          // Delay between batch items
          await new Promise(r => setTimeout(r, 2000)); 
          processNextInQueue(remaining);
        } catch (e) {
          setError(`Batch Error on file ${currentFile.name}: ${(e as Error).message}`);
          setIsProcessingQueue(false); // Stop on error
        }
      }
    };
    reader.readAsDataURL(currentFile);
  };

  const stopAllModes = () => {
    stopCamera();
    stopSimulation();
    
    // Stop Video Processing
    setProcessingVideo(false);
    videoProcessingRef.current = false;
    setVideoProgress(0);
    
    setIsProcessingQueue(false);
    setProcessingQueue([]);
    
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.src = "";
    }
    
    setImage(null);
    setResult(null);
    setStatus(AgentStatus.IDLE);
    setError(null);
    trackerRef.current.reset();
    clearOverlay();
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    clearOverlay();
  };

  const startCamera = async () => {
    stopAllModes();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      setCameraStream(stream);
      setIsCameraActive(true);
      trackerRef.current.reset();
      setError(null);
      navigateTo('monitor');
    } catch (err) {
      console.error(err);
      setError("Camera Access Denied: Please allow camera permissions in your browser settings to use the live feed.");
    }
  };

  // Real-time Location Discovery
  const handleLocationDiscovery = () => {
    if (!navigator.geolocation) {
      setError("Browser Unsupported: Your browser does not support Geolocation.");
      return;
    }
    setStatus(AgentStatus.DATA_ANALYSIS);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const context = await getLocationContext(latitude, longitude);
          setResult(prev => {
            if (prev) return { ...prev, locationContext: context };
            return null; 
          });
          if (result) {
             const updated = { ...result, locationContext: context };
             setResult(updated);
             setHistory(prev => prev.map(h => h.timestamp === updated.timestamp ? { ...updated, id: h.id, thumbnail: h.thumbnail } : h));
          }
          setStatus(AgentStatus.COMPLETE);
        } catch (e) {
          // Location context is optional, so we don't block the UI, just warn
          console.warn("Maps API context failed");
          setStatus(AgentStatus.COMPLETE); 
        }
      },
      (err) => {
        let msg = "Location Error: ";
        switch(err.code) {
          case err.PERMISSION_DENIED: msg += "User denied the request for Geolocation."; break;
          case err.POSITION_UNAVAILABLE: msg += "Location information is unavailable."; break;
          case err.TIMEOUT: msg += "The request to get user location timed out."; break;
          default: msg += "An unknown error occurred."; break;
        }
        setError(msg);
        setStatus(AgentStatus.IDLE);
      }
    );
  };

  const startSimulation = async () => {
    stopAllModes();
    simulationRef.current = true;
    setIsSimulating(true);
    setError(null);
    trackerRef.current.reset();
    navigateTo('monitor');
    
    for (let i = 0; i < SAMPLE_IMAGES.length; i++) {
      if (!simulationRef.current) break;
      const url = SAMPLE_IMAGES[i];
      try {
        const blob = await fetch(url).then(r => r.blob());
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onloadend = () => resolve(reader.result as string);
        });
        reader.readAsDataURL(blob);
        const base64Full = await base64Promise;
        
        setImage(base64Full);
        const matches = base64Full.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
           await processImage(matches[2], matches[1], 'single');
        }
        
        if (simulationRef.current) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch(e) { 
        console.warn("Simulation step failed", e);
        // Continue simulation even if one frame fails
      }
    }
    setIsSimulating(false);
  };

  const stopSimulation = () => {
    simulationRef.current = false;
    setIsSimulating(false);
    clearOverlay();
  };

  // Live Camera Processing Loop (Dynamic Backoff)
  useEffect(() => {
    let timeoutId: any;
    let isMounted = true;

    const loop = async () => {
        if (!isMounted) return;
        
        // Only run if active and previous cycle is complete (IDLE/COMPLETE/ERROR)
        // Note: processImage sets status to SCANNING, so loop naturally pauses until completion
        if (isCameraActive && videoRef.current && (status === AgentStatus.IDLE || status === AgentStatus.COMPLETE || status === AgentStatus.ERROR)) {
           const frame = captureFrame(videoRef.current);
           if (frame) {
             try {
                await processImage(frame.data, frame.mime, 'camera');
                // Normal delay
                timeoutId = setTimeout(loop, 4000);
             } catch (e: any) {
                console.warn("Camera loop error:", e.message);
                // Backoff delay if Rate Limit
                const delay = (e.message && (e.message.includes("Rate Limit") || e.message.includes("429"))) ? 10000 : 4000;
                timeoutId = setTimeout(loop, delay);
             }
             return;
           }
        }
        // If busy or no frame, check again soon
        timeoutId = setTimeout(loop, 1000);
    };

    if (isCameraActive) {
        loop();
    }

    return () => {
        isMounted = false;
        clearTimeout(timeoutId);
    };
  }, [isCameraActive, status]); // Re-evaluates when status changes (e.g. finishes processing)

  useEffect(() => {
    if (isCameraActive && videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [isCameraActive, cameraStream]);

  // DRAWING UTILS
  const drawDetections = (detections: any[]) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas size to displayed video
    const container = canvas.parentElement;
    if (container) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    detections.forEach(det => {
        if (det.box_2d) {
            // box: [ymin, xmin, ymax, xmax] 0-1000 normalized
            const [ymin, xmin, ymax, xmax] = det.box_2d;
            
            const x = (xmin / 1000) * canvas.width;
            const y = (ymin / 1000) * canvas.height;
            const w = ((xmax - xmin) / 1000) * canvas.width;
            const h = ((ymax - ymin) / 1000) * canvas.height;

            const isTracked = !!det.trackId;

            // Box Color based on Status
            let color = isTracked ? '#06b6d4' : '#94a3b8'; // Cyan for tracked, Slate for untracked
            let lineWidth = 2;
            
            if (det.isSpeeding) {
                color = '#ef4444'; // Red
                lineWidth = 4;
            } else if (det.isWrongWay) {
                color = '#f59e0b'; // Orange
                lineWidth = 3;
            } else if (isTracked) {
                color = '#22d3ee'; // Bright Cyan for active tracking
                lineWidth = 2;
            }

            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            
            // Draw Box
            ctx.strokeRect(x, y, w, h);
            
            // Draw distinct overlay for tracked items
            if (isTracked) {
                ctx.fillStyle = color + '20'; // 20 hex = ~12% opacity
                ctx.fillRect(x, y, w, h);
            }

            // Draw Label Background
            ctx.fillStyle = color;
            const labelHeight = 22;
            ctx.fillRect(x, y - labelHeight, w, labelHeight);
            
            // Draw Text
            ctx.fillStyle = det.isSpeeding || det.isWrongWay ? '#fff' : '#000';
            ctx.font = 'bold 11px "JetBrains Mono", monospace';
            
            // Construct Label
            let labelText = det.object.toUpperCase();
            if (isTracked) {
                labelText = `[#${det.trackId}] ${labelText}`;
            }
            
            // Override label for severe violations to keep it readable
            if (det.isSpeeding) labelText = `⚠️ SPEEDING [#${det.trackId}]`;
            else if (det.isWrongWay) labelText = `⛔ WRONG WAY [#${det.trackId}]`;
            
            ctx.fillText(labelText, x + 4, y - 6);
            
            // Draw Speed if available (secondary bottom tag)
            if (det.estimatedSpeed !== undefined) {
                const speedText = `${det.estimatedSpeed} km/h`;
                const speedMetrics = ctx.measureText(speedText);
                const sw = speedMetrics.width + 10;
                
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(x, y + h, sw, 16);
                
                ctx.fillStyle = '#fff';
                ctx.font = '10px monospace';
                ctx.fillText(speedText, x + 4, y + h + 12);
            }
        }
    });
  };

  const clearOverlay = () => {
    const canvas = overlayCanvasRef.current;
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Handle Capture Snapshot with Overlays
  const handleCaptureScreenshot = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const overlay = overlayCanvasRef.current;
    
    // Determine source and dimensions based on what's active
    let source: CanvasImageSource | null = null;
    let w = 0;
    let h = 0;

    if (activeView === 'monitor') {
        if (overlay) {
            w = overlay.width;
            h = overlay.height;
        }

        if (videoRef.current && (isCameraActive || processingVideo)) {
            source = videoRef.current;
        } else if (imgRef.current) {
            source = imgRef.current;
        }
    }

    if (source && overlay && w > 0 && h > 0 && ctx) {
        canvas.width = w;
        canvas.height = h;
        
        // Fill background black (handles aspect ratio gaps)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);
        
        // Draw Media
        ctx.drawImage(source, 0, 0, w, h);
        
        // Draw Overlay on top
        ctx.drawImage(overlay, 0, 0);

        // Trigger Download
        const link = document.createElement('a');
        link.download = `multi-ai-agent-snapshot-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    }
  };

  const processImage = async (base64Data: string, mimeType: string, mode: 'single' | 'video' | 'camera' = 'single') => {
    try {
      setStatus(AgentStatus.VISION_SCANNING);
      // Only delay if not in streaming modes
      if (mode === 'single') await new Promise(r => setTimeout(r, 500));
      
      setStatus(AgentStatus.DATA_ANALYSIS);
      const data = await analyzeTrafficImage(base64Data, mimeType);
      
      // RUN TRACKER
      const trackedDetections = trackerRef.current.update(data.detections, data.timestamp);
      data.detections = trackedDetections;
      
      // EXTRACT TRACKING-BASED VIOLATIONS
      const newViolations: Violation[] = [];
      trackedDetections.forEach(d => {
        if (d.isSpeeding) {
            newViolations.push({
                type: 'Speeding',
                description: `Vehicle ID:${d.trackId} moving at ${d.estimatedSpeed}km/h (Limit: 80)`,
                severity: 'High'
            });
        }
        if (d.isWrongWay) {
            newViolations.push({
                type: 'Wrong Lane',
                description: `Vehicle ID:${d.trackId} detected moving against dominant traffic flow.`,
                severity: 'High'
            });
        }
      });

      // Merge Tracking Violations with Gemini Visual Violations
      if (newViolations.length > 0) {
          data.analysis.detectedViolations = [...data.analysis.detectedViolations, ...newViolations];
      }
      
      // Update UI with Bounding Boxes
      drawDetections(trackedDetections);
      
      setStatus(AgentStatus.REPORT_GENERATION);
      if (mode === 'single') await new Promise(r => setTimeout(r, 500));

      setResult(data);
      
      // Accumulate video data for tracking visualization
      if (mode === 'video') {
        setVideoSessionData(prev => [...prev, data]);
      }
      
      const historyItem: HistoryItem = {
        ...data,
        id: Math.random().toString(36).substr(2, 9),
        thumbnail: `data:${mimeType};base64,${base64Data}`
      };
      setHistory(prev => [historyItem, ...prev]);

      setStatus(AgentStatus.COMPLETE);
      return true;
    } catch (err) {
      const errorMessage = (err as Error).message;
      console.error("Process Image Error:", errorMessage);
      
      if (mode === 'single') {
        setError(errorMessage);
        setStatus(AgentStatus.ERROR);
      }
      // For video/camera, we throw so the caller can log warn, but we don't break the whole UI state
      throw err;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 pb-12">
      <canvas ref={canvasRef} className="hidden" />

      {/* Navigation Header */}
      <header className="bg-slate-900/50 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <button onClick={goHome} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 bg-gradient-to-tr from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <span className="font-bold text-white text-lg">M</span>
            </div>
            <div className="text-left">
              <h1 className="font-bold text-lg tracking-tight text-white leading-none">Multi <span className="text-cyan-400">AI Agent</span></h1>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest leading-none mt-1">Traffic Monitor</p>
            </div>
          </button>
          
          <nav className="flex items-center gap-1 md:gap-4">
             <button 
                onClick={goHome} 
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeView === 'home' ? 'text-white bg-slate-800' : 'text-slate-400 hover:text-white'}`}
             >
                <Home className="w-4 h-4" /> 
                <span className="hidden md:inline">Home</span>
             </button>
             
             <button 
                onClick={() => navigateTo('monitor')} 
                disabled={!isMonitorActive}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeView === 'monitor' ? 'text-cyan-400 bg-cyan-950/30 border border-cyan-900' : 'text-slate-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed'}`}
             >
                <LayoutDashboard className="w-4 h-4" />
                <span className="hidden md:inline">Monitor</span>
                {isMonitorActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse ml-1"></span>
                )}
             </button>

             <button 
                onClick={() => navigateTo('history')} 
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeView === 'history' ? 'text-purple-400 bg-purple-950/30 border border-purple-900' : 'text-slate-400 hover:text-white'}`}
             >
                <HistoryIcon className="w-4 h-4" />
                <span className="hidden md:inline">Database</span>
             </button>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        
        {/* Error Display */}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {/* HOME VIEW: Upload & Hero */}
        {activeView === 'home' && (
          <div className="max-w-3xl mx-auto space-y-6 animate-fadeIn">
            <div className="text-center mb-10 pt-8">
              <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">Multi-Agent Traffic Intelligence</h2>
              <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed">
                 Deploy autonomous Gemini agents for real-time vehicle detection, violation tracking, and strategic traffic analysis.
              </p>
            </div>

            {/* Action Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* File Upload */}
              <label className="col-span-2 group relative flex flex-col items-center justify-center w-full h-56 rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/50 hover:bg-slate-800/50 hover:border-cyan-500/50 transition-all cursor-pointer overflow-hidden">
                <div className="flex flex-col items-center justify-center pt-5 pb-6 relative z-10">
                  <div className="w-16 h-16 mb-4 rounded-full bg-slate-800 flex items-center justify-center text-cyan-400 group-hover:bg-cyan-500/20 group-hover:scale-110 transition-all duration-300">
                    <Upload className="w-8 h-8" />
                  </div>
                  <p className="mb-2 text-lg text-slate-200 font-medium">Upload Footage or Images</p>
                  <p className="text-sm text-slate-500">Batch Processing & MP4 Video Support</p>
                </div>
                <input type="file" className="hidden" multiple accept="image/*,video/*" onChange={handleUpload} />
              </label>

              <button onClick={startCamera} className="p-6 rounded-2xl bg-slate-800 border border-slate-700 hover:border-red-500/50 hover:bg-slate-800/80 group transition-all relative overflow-hidden text-left">
                 <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Camera className="w-24 h-24 text-red-500" />
                 </div>
                 <div className="flex items-center gap-3 mb-3 relative z-10">
                   <div className="p-2 bg-red-500/10 rounded-lg"><Camera className="w-6 h-6 text-red-400" /></div>
                   <span className="font-bold text-white text-lg">Live Camera</span>
                 </div>
                 <p className="text-sm text-slate-400 relative z-10">Connect local stream for real-time monitoring.</p>
              </button>

              <button onClick={startSimulation} className="p-6 rounded-2xl bg-slate-800 border border-slate-700 hover:border-indigo-500/50 hover:bg-slate-800/80 group transition-all relative overflow-hidden text-left">
                 <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Layers className="w-24 h-24 text-indigo-500" />
                 </div>
                 <div className="flex items-center gap-3 mb-3 relative z-10">
                   <div className="p-2 bg-indigo-500/10 rounded-lg"><Layers className="w-6 h-6 text-indigo-400" /></div>
                   <span className="font-bold text-white text-lg">Simulation</span>
                 </div>
                 <p className="text-sm text-slate-400 relative z-10">Run batch analysis on sample datasets.</p>
              </button>
            </div>
            
            {history.length > 0 && (
               <div className="mt-12 p-6 rounded-2xl bg-slate-900/50 border border-slate-800">
                 <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 text-slate-300 font-semibold">
                      <Database className="w-5 h-5 text-purple-400" />
                      <span>Recent Database Entries</span>
                    </div>
                    <button onClick={() => navigateTo('history')} className="text-sm text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                      View Full DB <ChevronLeft className="w-4 h-4 rotate-180" />
                    </button>
                 </div>
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {history.slice(0, 4).map((h, i) => (
                        <div key={i} className="rounded-lg overflow-hidden border border-slate-700 relative group cursor-pointer" onClick={() => handleLoadHistoryItem(h)}>
                            <img src={h.thumbnail} className="w-full h-24 object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                            <div className="absolute bottom-0 w-full p-2 bg-gradient-to-t from-black/80 to-transparent text-[10px] text-white font-mono">
                                {new Date(h.timestamp).toLocaleTimeString()}
                            </div>
                        </div>
                    ))}
                 </div>
               </div>
            )}
          </div>
        )}

        {/* MONITOR VIEW: Video & Dashboard */}
        {/* We use 'hidden' class to preserve state (video playing) when navigating away */}
        <div className={activeView === 'monitor' ? 'block animate-fadeIn' : 'hidden'}>
          {activeView === 'monitor' && (
             <div className="mb-4">
                <button onClick={goBack} className="text-sm text-slate-400 hover:text-white flex items-center gap-1">
                   <ChevronLeft className="w-4 h-4" /> Back
                </button>
             </div>
          )}

          {isMonitorActive ? (
            <>
                <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 shadow-2xl mb-8">
                     
                    {/* Media Display */}
                    <div className="relative rounded-lg overflow-hidden bg-black aspect-video mb-6 ring-1 ring-slate-700">
                      
                      {/* VIDEO LAYER */}
                      {(isCameraActive || processingVideo) ? (
                        <video ref={videoRef} autoPlay={isCameraActive} muted playsInline className="w-full h-full object-contain absolute inset-0 z-10" />
                      ) : (
                        image && <img ref={imgRef} src={image} alt="Target" className="w-full h-full object-contain absolute inset-0 z-10" />
                      )}
                      
                      {/* OVERLAY LAYER (Bounding Boxes) */}
                      <canvas ref={overlayCanvasRef} className="absolute inset-0 z-20 w-full h-full pointer-events-none" />

                      {/* SCANNER EFFECT LAYER */}
                      {(status !== AgentStatus.IDLE && status !== AgentStatus.COMPLETE && status !== AgentStatus.ERROR) && (
                          <div className="absolute inset-0 pointer-events-none z-30">
                            <div className="w-full h-1 bg-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.8)] animate-scan absolute top-0"></div>
                            <div className="absolute bottom-4 right-4 bg-black/50 text-cyan-400 text-xs px-2 py-1 rounded border border-cyan-500/30">
                              VISION AGENT ACTIVE
                            </div>
                          </div>
                      )}
                    </div>

                    {/* Video Progress Bar */}
                    {processingVideo && (
                      <div className="mb-6">
                        <div className="flex justify-between text-xs text-slate-400 mb-1">
                          <span className="flex items-center gap-2"><Film className="w-3 h-3"/> Video Analysis</span>
                          <span>{Math.round(videoProgress)}% Complete</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500 ease-out" 
                            style={{ width: `${videoProgress}%` }}
                          />
                        </div>
                      </div>
                    )}
                    
                    {/* Control Bar */}
                    <div className="flex flex-wrap justify-between items-center gap-4">
                      <div className="flex gap-3">
                        <button onClick={stopAllModes} className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors flex items-center gap-2 text-sm font-medium border border-transparent hover:border-slate-700">
                          <RotateCcw className="w-4 h-4" /> Reset
                        </button>
                        
                        <button onClick={handleCaptureScreenshot} className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors flex items-center gap-2 text-sm font-medium border border-transparent hover:border-slate-700">
                          <Download className="w-4 h-4" /> Snapshot
                        </button>
                      </div>

                      <div className="flex gap-3">
                        {result && !processingVideo && (
                          <button onClick={handleLocationDiscovery} className="px-4 py-2 bg-indigo-900/30 text-indigo-300 border border-indigo-500/30 rounded-lg hover:bg-indigo-900/50 text-sm flex items-center gap-2">
                            <LocateFixed className="w-4 h-4" /> 
                            {result.locationContext ? 'Update Location' : 'Locate Realtime (Maps)'}
                          </button>
                        )}

                        {(isSimulating || processingVideo) && (
                          <button onClick={stopAllModes} className="px-4 py-2 text-red-400 border border-red-900/50 bg-red-900/20 rounded-lg text-sm flex items-center gap-2">
                            <StopCircle className="w-4 h-4" /> Stop {processingVideo ? 'Video' : 'Sim'}
                          </button>
                        )}
                        
                        {isProcessingQueue && (
                           <span className="px-4 py-2 text-cyan-400 bg-cyan-900/20 border border-cyan-900/50 rounded-lg text-sm flex items-center gap-2 animate-pulse">
                             <Layers className="w-4 h-4" /> Processing Batch ({processingQueue.length} remaining)
                           </span>
                        )}

                        {!isSimulating && !isCameraActive && !processingVideo && status === AgentStatus.IDLE && !isProcessingQueue && (
                          <button onClick={() => {
                             const matches = image?.match(/^data:(.+);base64,(.+)$/);
                             if(matches) processImage(matches[2], matches[1], 'single');
                          }} className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-bold shadow-lg shadow-cyan-500/20 flex items-center gap-2">
                            <Play className="w-4 h-4 fill-current" /> Analyze
                          </button>
                        )}
                      </div>
                    </div>
                </div>

                {/* Pipeline Viz */}
                {(status !== AgentStatus.IDLE || result) && <div className="mb-8"><AgentPipeline status={status} /></div>}

                {/* Results */}
                {(result) && (
                   <div className="space-y-6 animate-fadeIn">
                     <ResultsDashboard 
                        data={result} 
                        history={history} 
                        videoSessionData={videoSessionData} 
                        onLoadHistoryItem={handleLoadHistoryItem}
                     />
                   </div>
                )}
            </>
          ) : (
            <div className="text-center py-20 bg-slate-900 rounded-2xl border border-slate-800 border-dashed">
                <LayoutDashboard className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                <h3 className="text-slate-300 font-bold text-lg">No Active Monitor Session</h3>
                <p className="text-slate-500 text-sm mb-6">Start a camera feed or upload a video from Home.</p>
                <button onClick={goHome} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium">Go to Home</button>
            </div>
          )}
        </div>

        {/* HISTORY VIEW: Database */}
        {activeView === 'history' && (
           <div className="animate-fadeIn">
              <div className="mb-6 flex items-center justify-between">
                <button onClick={goBack} className="text-sm text-slate-400 hover:text-white flex items-center gap-1">
                   <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                   <Database className="w-5 h-5 text-purple-400" /> Complete Analysis Database
                </h2>
              </div>
              
              {/* Reuse ResultsDashboard in History Mode by passing null active data */}
              <ResultsDashboard 
                data={null} 
                history={history} 
                videoSessionData={[]} 
                onLoadHistoryItem={handleLoadHistoryItem}
              />
           </div>
        )}

      </main>
    </div>
  );
}
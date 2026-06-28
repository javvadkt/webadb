'use client';

import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Battery, 
  Cpu, 
  HardDrive, 
  Zap, 
  ArrowDown, 
  ArrowUp, 
  X, 
  RefreshCw,
  Gauge,
  Activity,
  Maximize2,
  Minimize2
} from 'lucide-react';
import { TelemetryState, INITIAL_TELEMETRY_STATE, parseTelemetry } from '../utils/telemetryParser';

interface TelemetryHUDProps {
  adb: any; // Adb instance
  isOpen: boolean;
  onClose: () => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

const COMBINED_TELEMETRY_COMMAND = `
echo "---BATTERY---" && dumpsys battery | grep -E 'level|temperature|voltage'
echo "---CPU_FREQ---" && cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq
echo "---MEM---" && cat /proc/meminfo | grep -E 'MemTotal|MemAvailable'
echo "---NET---" && cat /proc/net/dev | grep 'wlan0'
echo "---GPU---" && cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percent 2>/dev/null || echo "0"
`;

export default function TelemetryHUD({ adb, isOpen, onClose, containerRef }: TelemetryHUDProps) {
  const [telemetry, setTelemetry] = useState<TelemetryState>(INITIAL_TELEMETRY_STATE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  
  // Position offsets for the floating HUD
  const [position, setPosition] = useState({ x: 20, y: 80 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const hudRef = useRef<HTMLDivElement | null>(null);

  // References to keep track of the parser state across ticks
  const telemetryRef = useRef<TelemetryState>(INITIAL_TELEMETRY_STATE);
  const lastTimestampRef = useRef<number>(0);

  useEffect(() => {
    if (!isOpen || !adb) {
      setTimeout(() => {
        setIsLoading(true);
        setError(null);
      }, 0);
      return;
    }

    let active = true;
    let intervalId: any = null;

    const fetchTelemetryTick = async () => {
      try {
        if (!adb?.subprocess?.noneProtocol?.spawnWaitText) {
          throw new Error("ADB client does not support subprocess command execution.");
        }

        const rawOutput = await adb.subprocess.noneProtocol.spawnWaitText(COMBINED_TELEMETRY_COMMAND);
        
        if (!active) return;

        const { data, timestamp } = parseTelemetry(
          rawOutput,
          telemetryRef.current,
          lastTimestampRef.current
        );

        telemetryRef.current = data;
        lastTimestampRef.current = timestamp;

        setTelemetry(data);
        setIsLoading(false);
        setError(null);
      } catch (err: any) {
        console.warn("Telemetry polling failed:", err);
        if (active) {
          setError(err?.message || "Failed to execute diagnostic commands on target device.");
          setIsLoading(false);
        }
      }
    };

    // Execute immediately on open, then poll every 1 second
    fetchTelemetryTick();
    intervalId = setInterval(fetchTelemetryTick, 1000);

    return () => {
      active = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isOpen, adb]);

  // Handle Dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hud-header-button')) return;
    
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDraggingRef.current) return;
    
    let newX = e.clientX - dragStartRef.current.x;
    let newY = e.clientY - dragStartRef.current.y;

    // Boundary checks relative to container (if provided)
    if (containerRef?.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const hudRect = hudRef.current?.getBoundingClientRect();
      const hudWidth = hudRect?.width || 320;
      const hudHeight = hudRect?.height || 400;

      newX = Math.max(10, Math.min(newX, rect.width - hudWidth - 10));
      newY = Math.max(10, Math.min(newY, rect.height - hudHeight - 10));
    } else {
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
    }

    setPosition({ x: newX, y: newY });
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  // Helper to color CPU badges based on frequency
  const getCpuBadgeColor = (mhz: number) => {
    if (mhz < 1300) return 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40';
    if (mhz < 2000) return 'bg-amber-950/60 text-amber-400 border-amber-800/40';
    return 'bg-rose-950/60 text-rose-400 border-rose-800/40';
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        ref={hudRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
        className="absolute z-50 w-80 bg-slate-950/90 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl text-slate-100 flex flex-col overflow-hidden select-none"
      >
        {/* Title Bar / Drag Handle */}
        <div 
          onMouseDown={handleMouseDown}
          className="px-3.5 py-2 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between cursor-move"
        >
          <div className="flex items-center space-x-2">
            <Gauge className="w-4 h-4 text-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold tracking-wider text-slate-200">DEVICE DIAGNOSTICS</span>
            {isLoading && <RefreshCw className="w-3 h-3 text-emerald-400 animate-spin" />}
          </div>
          <div className="flex items-center space-x-1.5 hud-header-button">
            <button 
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded transition-colors"
              title={isMinimized ? "Expand HUD" : "Minimize HUD"}
            >
              {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
            </button>
            <button 
              onClick={onClose}
              className="p-1 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 rounded transition-colors"
              title="Close HUD"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* HUD Contents */}
        {!isMinimized && (
          <div className="p-3.5 space-y-3.5 max-h-[480px] overflow-y-auto custom-scrollbar text-[11px]">
            {error ? (
              <div className="p-3 bg-rose-950/30 border border-rose-900/50 rounded-lg text-rose-400 text-center space-y-1">
                <p className="font-semibold">Diagnostics Error</p>
                <p className="text-[10px] opacity-90">{error}</p>
                <p className="text-[9px] text-slate-500 pt-1">Polling diagnostics requires debugging permissions.</p>
              </div>
            ) : isLoading ? (
              <div className="py-8 flex flex-col items-center justify-center space-y-2 text-slate-400">
                <RefreshCw className="w-6 h-6 text-emerald-400 animate-spin" />
                <span className="text-xs animate-pulse">Establishing diagnostics link...</span>
              </div>
            ) : (
              <>
                {/* 1. CPU Section */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-slate-400">
                    <div className="flex items-center space-x-1">
                      <Cpu className="w-3.5 h-3.5 text-sky-400" />
                      <span className="font-medium text-slate-300 uppercase tracking-wider text-[10px]">CPU Frequency Matrix</span>
                    </div>
                    <span className="font-mono text-slate-300">Avg: {telemetry.cpu.averageFreq} MHz</span>
                  </div>

                  {telemetry.cpu.cores.length > 0 ? (
                    <div className="grid grid-cols-4 gap-1 pt-1">
                      {telemetry.cpu.cores.map((freq, index) => (
                        <div 
                          key={index}
                          className={`py-1 border rounded text-center font-mono text-[9px] transition-colors border-slate-800 ${getCpuBadgeColor(freq)}`}
                        >
                          <div className="text-slate-500 text-[8px] leading-none mb-0.5">C{index}</div>
                          <div className="font-bold">
                            {freq >= 1000 ? `${(freq / 1000).toFixed(2)}G` : `${freq}M`}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-500 text-center py-1 bg-slate-900/30 rounded border border-slate-900">
                      CPU frequency nodes unreachable
                    </div>
                  )}
                </div>

                {/* 2. RAM & GPU Grid */}
                <div className="grid grid-cols-2 gap-3.5">
                  {/* RAM Column */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-slate-400">
                      <div className="flex items-center space-x-1">
                        <HardDrive className="w-3.5 h-3.5 text-violet-400" />
                        <span className="font-medium text-slate-300 uppercase tracking-wider text-[10px]">Memory (RAM)</span>
                      </div>
                    </div>
                    
                    <div className="bg-slate-900/50 p-2 rounded-lg border border-slate-800/40 space-y-1">
                      <div className="flex justify-between font-mono">
                        <span className="text-slate-400">Used:</span>
                        <span className="font-bold text-slate-200">{(telemetry.ram.used / 1024).toFixed(1)}G</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-slate-400">Total:</span>
                        <span className="text-slate-300">{(telemetry.ram.total / 1024).toFixed(1)}G</span>
                      </div>
                      
                      {/* RAM usage bar */}
                      <div className="space-y-1 pt-1">
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-violet-500 rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${telemetry.ram.percentage}%` }}
                            transition={{ duration: 0.5 }}
                          />
                        </div>
                        <div className="flex justify-between text-[8px] text-slate-500 font-mono">
                          <span>0%</span>
                          <span className="text-violet-400 font-semibold">{telemetry.ram.percentage}%</span>
                          <span>100%</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* GPU Column */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-slate-400">
                      <div className="flex items-center space-x-1">
                        <Activity className="w-3.5 h-3.5 text-amber-400" />
                        <span className="font-medium text-slate-300 uppercase tracking-wider text-[10px]">GPU LOAD</span>
                      </div>
                    </div>

                    <div className="bg-slate-900/50 p-2 rounded-lg border border-slate-800/40 space-y-1 flex flex-col justify-between h-[80px]">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400">Engine state:</span>
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${telemetry.gpu.load > 40 ? 'bg-amber-950/60 text-amber-400 border border-amber-800/40' : 'bg-slate-800 text-slate-400'}`}>
                          {telemetry.gpu.load > 70 ? 'LOADED' : telemetry.gpu.load > 0 ? 'ACTIVE' : 'IDLE'}
                        </span>
                      </div>

                      {/* GPU usage bar */}
                      <div className="space-y-1 pt-1.5">
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-amber-500 rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${telemetry.gpu.load}%` }}
                            transition={{ duration: 0.5 }}
                          />
                        </div>
                        <div className="flex justify-between text-[8px] text-slate-500 font-mono">
                          <span>0%</span>
                          <span className="text-amber-400 font-semibold">{telemetry.gpu.load}%</span>
                          <span>100%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. Battery Section */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-slate-400">
                    <div className="flex items-center space-x-1">
                      <Battery className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="font-medium text-slate-300 uppercase tracking-wider text-[10px]">Battery Diagnostics</span>
                    </div>
                    <span className="font-mono text-slate-300">{telemetry.battery.level}%</span>
                  </div>

                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800/40 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-slate-500 text-[8px] uppercase tracking-wider">TEMP</div>
                      <div className="font-mono font-bold text-slate-200 mt-0.5">{telemetry.battery.temperature.toFixed(1)}°C</div>
                    </div>
                    <div>
                      <div className="text-slate-500 text-[8px] uppercase tracking-wider">VOLTS</div>
                      <div className="font-mono font-bold text-slate-200 mt-0.5">{telemetry.battery.voltage.toFixed(2)} V</div>
                    </div>
                    <div>
                      <div className="text-slate-500 text-[8px] uppercase tracking-wider">STATUS</div>
                      <div className="font-mono font-bold text-emerald-400 mt-0.5">OPTIMAL</div>
                    </div>
                  </div>
                </div>

                {/* 4. Network Activity */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-slate-400">
                    <div className="flex items-center space-x-1">
                      <Zap className="w-3.5 h-3.5 text-pink-400" />
                      <span className="font-medium text-slate-300 uppercase tracking-wider text-[10px]">Real-Time Traffic (wlan0)</span>
                    </div>
                  </div>

                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800/40 grid grid-cols-2 gap-4">
                    <div className="flex items-center space-x-2.5">
                      <div className="p-1.5 bg-sky-950/40 border border-sky-900/40 text-sky-400 rounded-md">
                        <ArrowDown className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <div className="text-slate-500 text-[8px] uppercase tracking-wider">DOWNLOAD</div>
                        <div className="font-mono font-bold text-slate-200 text-xs">
                          {telemetry.network.downloadSpeed >= 1024 
                            ? `${(telemetry.network.downloadSpeed / 1024).toFixed(1)} MB/s` 
                            : `${telemetry.network.downloadSpeed} KB/s`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2.5">
                      <div className="p-1.5 bg-pink-950/40 border border-pink-900/40 text-pink-400 rounded-md">
                        <ArrowUp className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <div className="text-slate-500 text-[8px] uppercase tracking-wider">UPLOAD</div>
                        <div className="font-mono font-bold text-slate-200 text-xs">
                          {telemetry.network.uploadSpeed >= 1024 
                            ? `${(telemetry.network.uploadSpeed / 1024).toFixed(1)} MB/s` 
                            : `${telemetry.network.uploadSpeed} KB/s`}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

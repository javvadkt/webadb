'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { 
  Smartphone, 
  Cpu, 
  Lock, 
  HelpCircle, 
  RefreshCw, 
  AlertCircle, 
  Usb, 
  CheckCircle2, 
  ExternalLink,
  Search,
  X,
  Play,
  Globe,
  Wifi,
  Terminal,
  Key
} from 'lucide-react';
import { AdbManager, ConnectionState, ScrcpySettings } from './utils/adbManager';
import ScrcpyViewer from './components/ScrcpyViewer';
import { AdbScrcpyClient } from '@yume-chan/adb-scrcpy';
import { AdbWebUsbBackend } from '@yume-chan/adb-backend-webusb';

export default function App() {
  const [manager] = useState(() => new AdbManager());
  const [connectionState, setConnectionState] = useState<ConnectionState>({ status: 'idle' });
  const [pairedDevices, setPairedDevices] = useState<AdbWebUsbBackend[]>([]);
  const [scrcpyClient, setScrcpyClient] = useState<AdbScrcpyClient<any> | null>(null);

  const [connectionType, setConnectionType] = useState<'usb' | 'remote'>('usb');
  const [remoteUrl, setRemoteUrl] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('adb_remote_url') || 'wss://your-relay-app.onrender.com/client';
    }
    return 'wss://your-relay-app.onrender.com/client';
  });
  const [remoteToken, setRemoteToken] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('adb_remote_token') || '';
    }
    return '';
  });

  const handleConnectRemote = async () => {
    if (!remoteUrl.trim()) return;
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('adb_remote_url', remoteUrl.trim());
        localStorage.setItem('adb_remote_token', remoteToken.trim());
      }
      
      let fullUrl = remoteUrl.trim();
      if (remoteToken.trim() && !fullUrl.includes('token=')) {
        const separator = fullUrl.includes('?') ? '&' : '?';
        fullUrl = `${fullUrl}${separator}token=${encodeURIComponent(remoteToken.trim())}`;
      }

      const client = await manager.connectRemote(fullUrl, (state) => {
        setConnectionState(state);
      }, settings);
      setScrcpyClient(client);
    } catch (err: any) {
      console.error("Remote WebSocket connection workflow failed:", err);
      setConnectionState({
        status: 'disconnected',
        error: err?.message || String(err),
      });
    }
  };

  const [showAppLauncher, setShowAppLauncher] = useState<boolean>(false);
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState<boolean>(false);
  const [appSearchTerm, setAppSearchTerm] = useState<string>('');
  
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [settings, setSettings] = useState<ScrcpySettings>({
    videoBitRate: 2000000,
    maxSize: 800,
    maxFps: 30,
    tunnelForward: true,
    turnScreenOff: false,
    audio: true,
    muteDeviceSpeaker: true,
  });

  // Compatibility flags checked at runtime
  const [isSecure, setIsSecure] = useState<boolean>(true);
  const [hasWebUsb, setHasWebUsb] = useState<boolean>(true);
  const [hasWebCodecs, setHasWebCodecs] = useState<boolean>(true);
  const [compatibilityChecked, setCompatibilityChecked] = useState<boolean>(false);

  const loadPairedDevices = React.useCallback(async () => {
    try {
      const devices = await manager.getPairedDevices();
      setPairedDevices(devices);
    } catch (e) {
      console.error("Failed to fetch paired devices:", e);
    }
  }, [manager]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const init = async () => {
        setIsSecure(window.isSecureContext);
        setHasWebUsb(!!navigator.usb);
        setHasWebCodecs('VideoDecoder' in window);
        setCompatibilityChecked(true);
        if (navigator.usb) {
          await loadPairedDevices();
        }
      };
      init();

      if (navigator.usb) {
        const handleUsbDisconnect = () => {
          setConnectionState((prev) => {
            if (prev.status !== 'idle' && prev.status !== 'disconnected') {
              return { status: 'disconnected', error: 'USB device was physically unplugged.' };
            }
            return prev;
          });
          setScrcpyClient(null);
          loadPairedDevices();
        };

        navigator.usb.addEventListener('disconnect', handleUsbDisconnect);
        return () => {
          navigator.usb.removeEventListener('disconnect', handleUsbDisconnect);
        };
      }
    }
  }, [loadPairedDevices]);

  const handleConnectDevice = async (backend: AdbWebUsbBackend) => {
    try {
      const client = await manager.connect(backend, (state) => {
        setConnectionState(state);
      }, settings);
      setScrcpyClient(client);
    } catch (err) {
      console.error("Connection workflow failed:", err);
    }
  };

  const handleRequestAndConnect = async () => {
    try {
      const device = await manager.requestNewDevice();
      await handleConnectDevice(device);
    } catch (err: any) {
      console.error("Claiming new USB device failed:", err);
      // Exclude user-cancelled action from error display
      if (err?.name !== 'NotFoundError' && err?.message !== 'No device selected.') {
        setConnectionState({
          status: 'disconnected',
          error: err?.message || String(err),
        });
      }
    }
  };

  const handleDisconnect = async () => {
    await manager.disconnect();
    setScrcpyClient(null);
    setConnectionState({ status: 'idle' });
    setShowAppLauncher(false);
    loadPairedDevices();
  };

  const handleRetryConnection = () => {
    if (connectionType === 'usb') {
      handleRequestAndConnect();
    } else {
      handleConnectRemote();
    }
  };

  const handleOpenLauncher = async () => {
    setShowAppLauncher(true);
    if (installedApps.length === 0) {
      setIsLoadingApps(true);
      const apps = await manager.getInstalledApps();
      setInstalledApps(apps);
      setIsLoadingApps(false);
    }
  };

  const handleLaunchApp = async (packageName: string) => {
    await manager.launchApp(packageName);
    setShowAppLauncher(false);
  };

  // Compatibility warning banners
  if (compatibilityChecked && (!isSecure || !hasWebUsb || !hasWebCodecs)) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 p-6 text-gray-200">
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-lg p-6 bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl"
        >
          <div className="flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-red-950/40 border border-red-500/30 text-red-400">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-gray-100 mb-2">Browser Configuration Error</h2>
          <p className="text-sm text-gray-400 mb-6 leading-relaxed">
            WebADB Scrcpy operates entirely within your web browser using cutting-edge Web APIs. Your current browser session lacks the required specifications:
          </p>

          <div className="space-y-3 mb-6">
            <div className="flex items-start space-x-3 p-3 rounded-lg bg-gray-950/50 border border-gray-800/80">
              <div className={`w-2.5 h-2.5 rounded-full mt-1 ${isSecure ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div>
                <h4 className="text-xs font-semibold text-gray-300">Secure Context (HTTPS/Localhost)</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {isSecure ? 'Active' : 'Missing. Browsers strictly limit WebUSB access to secure contexts.'}
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3 p-3 rounded-lg bg-gray-950/50 border border-gray-800/80">
              <div className={`w-2.5 h-2.5 rounded-full mt-1 ${hasWebUsb ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div>
                <h4 className="text-xs font-semibold text-gray-300">WebUSB API Support</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {hasWebUsb ? 'Active' : 'Missing. Please use Google Chrome, Edge, or Opera.'}
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3 p-3 rounded-lg bg-gray-950/50 border border-gray-800/80">
              <div className={`w-2.5 h-2.5 rounded-full mt-1 ${hasWebCodecs ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div>
                <h4 className="text-xs font-semibold text-gray-300">WebCodecs (VideoDecoder) API</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {hasWebCodecs ? 'Active' : 'Missing. Hardware video stream decoding requires this browser engine.'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col space-y-3">
            <a 
              href={typeof window !== 'undefined' ? window.location.href.replace('http://', 'https://') : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-full px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors shadow"
            >
              Open in Secure HTTPS
              <ExternalLink className="w-3 h-3 ml-1.5" />
            </a>
            <button 
              onClick={() => typeof window !== 'undefined' && window.location.reload()}
              className="px-4 py-2 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors border border-gray-700"
            >
              Reload Page
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
      {/* Premium Header */}
      <header className="border-b border-gray-900 bg-gray-950/80 backdrop-blur-md sticky top-0 z-10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-emerald-950/50 border border-emerald-500/30 text-emerald-400">
              <Smartphone className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-md font-bold tracking-tight text-gray-100 flex items-center">
                WebADB Scrcpy
                <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 bg-emerald-950 text-emerald-400 rounded border border-emerald-900/30">Client Only</span>
              </h1>
              <p className="text-[11px] text-gray-500 mt-0.5 font-mono">100% Client-Side Android Screen Mirroring</p>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow max-w-6xl w-full mx-auto p-6 flex flex-col justify-center">
        {connectionState.status === 'idle' && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto w-full"
          >
            {/* Left column - Instructions */}
            <div className="md:col-span-1 space-y-4">
              <h2 className="text-lg font-bold text-gray-200">Quick Setup Guide</h2>
              <div className="space-y-3">
                <div className="flex space-x-3 p-3 bg-gray-900/50 border border-gray-800/80 rounded-xl">
                  <div className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-950 text-emerald-400 font-mono text-[10px] font-bold border border-emerald-500/20 mt-0.5 shrink-0">1</div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Open Settings on your Android phone, find <span className="text-gray-200 font-medium">Developer Options</span>, and enable <span className="text-emerald-400 font-medium">USB Debugging</span>.
                  </p>
                </div>
                <div className="flex space-x-3 p-3 bg-gray-900/50 border border-gray-800/80 rounded-xl">
                  <div className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-950 text-emerald-400 font-mono text-[10px] font-bold border border-emerald-500/20 mt-0.5 shrink-0">2</div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Connect your phone to this computer using a USB-C data cable. Select &quot;File Transfer&quot; or &quot;MIDI&quot; USB configuration if prompted.
                  </p>
                </div>
                <div className="flex space-x-3 p-3 bg-gray-900/50 border border-gray-800/80 rounded-xl">
                  <div className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-950 text-emerald-400 font-mono text-[10px] font-bold border border-emerald-500/20 mt-0.5 shrink-0">3</div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Click <span className="text-gray-200 font-medium">Connect Android Device</span>, select your device from the browser popup, and approve the ADB authentication dialog on your phone screen!
                  </p>
                </div>
              </div>

              {/* Advanced Settings Toggle */}
              <div className="pt-4 border-t border-gray-800/50">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="flex items-center text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  <Cpu className="w-3.5 h-3.5 mr-1.5" />
                  {showSettings ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
                </button>

                {showSettings && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="mt-4 p-4 bg-gray-900/40 border border-gray-800/60 rounded-xl space-y-4"
                  >
                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1">Max Resolution Size: {settings.maxSize}px</label>
                      <input 
                        type="range" 
                        min="480" max="1920" step="10"
                        value={settings.maxSize} 
                        onChange={(e) => setSettings({...settings, maxSize: parseInt(e.target.value)})}
                        className="w-full accent-emerald-500"
                      />
                      <p className="text-[10px] text-gray-500 mt-1">Lower if connection drops immediately.</p>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1">Video Bitrate: {Math.round((settings.videoBitRate || 2000000) / 1000000)} Mbps</label>
                      <input 
                        type="range" 
                        min="1000000" max="8000000" step="500000"
                        value={settings.videoBitRate} 
                        onChange={(e) => setSettings({...settings, videoBitRate: parseInt(e.target.value)})}
                        className="w-full accent-emerald-500"
                      />
                      <p className="text-[10px] text-gray-500 mt-1">Lower if the stream lags or glitches.</p>
                    </div>
                    
                    <div>
                      <label className="text-xs font-medium text-gray-300 block mb-1">Max FPS: {settings.maxFps}</label>
                      <input 
                        type="range" 
                        min="15" max="120" step="5"
                        value={settings.maxFps} 
                        onChange={(e) => setSettings({...settings, maxFps: parseInt(e.target.value)})}
                        className="w-full accent-emerald-500"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-xs font-medium text-gray-300 block">Forward Tunnel</label>
                        <p className="text-[10px] text-gray-500">Toggle if you see &quot;transferIn&quot; error.</p>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={settings.tunnelForward} 
                        onChange={(e) => setSettings({...settings, tunnelForward: e.target.checked})}
                        className="accent-emerald-500 w-4 h-4"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-xs font-medium text-gray-300 block">Turn off screen</label>
                        <p className="text-[10px] text-gray-500">Keep phone screen black while mirroring.</p>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={settings.turnScreenOff} 
                        onChange={(e) => setSettings({...settings, turnScreenOff: e.target.checked})}
                        className="accent-emerald-500 w-4 h-4"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-xs font-medium text-gray-300 block">Audio Forwarding</label>
                        <p className="text-[10px] text-gray-500">Play phone audio through browser (Android 11+).</p>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={settings.audio} 
                        onChange={(e) => setSettings({...settings, audio: e.target.checked})}
                        className="accent-emerald-500 w-4 h-4"
                      />
                    </div>

                    {settings.audio && (
                      <div className="flex items-center justify-between pl-4 border-l border-emerald-950/40">
                        <div>
                          <label className="text-xs font-medium text-gray-300 block">Mute Phone Speaker</label>
                          <p className="text-[10px] text-gray-500">Silence phone speaker (sound only plays on PC).</p>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={settings.muteDeviceSpeaker ?? false} 
                          onChange={(e) => setSettings({...settings, muteDeviceSpeaker: e.target.checked})}
                          className="accent-emerald-500 w-4 h-4"
                        />
                      </div>
                    )}
                  </motion.div>
                )}
              </div>
            </div>

            {/* Right column - Connection Panel */}
            <div className="md:col-span-2 flex flex-col justify-start items-center p-8 bg-gray-900/40 border border-gray-800/60 rounded-2xl min-h-[480px]">
              
              {/* Tab Selector */}
              <div className="flex bg-gray-950 p-1 rounded-xl mb-8 border border-gray-800/40 w-full max-w-sm">
                <button
                  onClick={() => setConnectionType('usb')}
                  className={`flex-1 flex items-center justify-center space-x-2 py-2 text-xs font-semibold rounded-lg transition-all ${
                    connectionType === 'usb'
                      ? 'bg-emerald-600/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-950'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-900/50 border border-transparent'
                  }`}
                >
                  <Usb className="w-3.5 h-3.5" />
                  <span>Wired (WebUSB)</span>
                </button>
                <button
                  onClick={() => setConnectionType('remote')}
                  className={`flex-1 flex items-center justify-center space-x-2 py-2 text-xs font-semibold rounded-lg transition-all ${
                    connectionType === 'remote'
                      ? 'bg-emerald-600/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-950'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-900/50 border border-transparent'
                  }`}
                >
                  <Wifi className="w-3.5 h-3.5" />
                  <span>Remote (WebSocket)</span>
                </button>
              </div>

              {connectionType === 'usb' ? (
                <div className="flex flex-col items-center text-center w-full">
                  <div className="w-16 h-16 bg-emerald-950/30 border border-emerald-500/20 rounded-2xl flex items-center justify-center text-emerald-400 mb-6">
                    <Usb className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-bold text-gray-200 mb-2">Connect Your Android Device</h3>
                  <p className="text-xs text-gray-500 max-w-sm mb-6 leading-relaxed">
                    Unlock high-performance screen mirroring and low-latency interaction directly over USB. No apps, no drivers, and no servers required.
                  </p>

                  <button
                    onClick={handleRequestAndConnect}
                    className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl shadow-lg shadow-emerald-900/20 hover:shadow-emerald-900/30 transition-all flex items-center space-x-2 text-sm"
                  >
                    <Usb className="w-4 h-4" />
                    <span>Connect Android Device</span>
                  </button>

                  {/* Paired devices list */}
                  {pairedDevices.length > 0 && (
                    <div className="w-full max-w-sm mt-8 border-t border-gray-800/80 pt-6">
                      <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
                        <span>Already Paired Devices</span>
                        <button onClick={loadPairedDevices} className="text-emerald-400 hover:underline flex items-center">
                          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                        </button>
                      </div>
                      <div className="space-y-2">
                        {pairedDevices.map((device, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleConnectDevice(device)}
                            className="w-full flex items-center justify-between p-3 bg-gray-950/60 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 rounded-xl transition-all text-left group"
                          >
                            <div className="flex items-center space-x-3">
                              <Smartphone className="w-4 h-4 text-emerald-400" />
                              <span className="text-xs font-semibold text-gray-300">{device.name || "Android Device"}</span>
                            </div>
                            <CheckCircle2 className="w-3.5 h-3.5 text-gray-600 group-hover:text-emerald-400 transition-colors" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center w-full">
                  <div className="w-16 h-16 bg-emerald-950/30 border border-emerald-500/20 rounded-2xl flex items-center justify-center text-emerald-400 mb-6">
                    <Wifi className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-bold text-gray-200 mb-2">Remote WebSocket Connection</h3>
                  <p className="text-xs text-gray-500 max-w-sm mb-6 leading-relaxed text-center">
                    Establish a low-latency mirror stream from a remote device connected to a free Render/Railway server relay channel.
                  </p>

                  <div className="w-full max-w-md bg-gray-950/50 border border-gray-800/80 p-5 rounded-xl mb-6 text-left animate-fade-in space-y-4">
                    <div>
                      <label className="text-xs font-medium text-gray-400 block mb-1.5">ADB WebSocket Relay URL</label>
                      <div className="relative">
                        <Terminal className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                        <input
                          type="text"
                          value={remoteUrl}
                          onChange={(e) => setRemoteUrl(e.target.value)}
                          placeholder="wss://adbcloud.onrender.com/client"
                          className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-4 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs font-medium text-gray-400">Access Token / Password (Optional)</label>
                        <span className="text-[9px] text-gray-500 font-mono">?token=...</span>
                      </div>
                      <div className="relative">
                        <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                        <input
                          type="password"
                          value={remoteToken}
                          onChange={(e) => setRemoteToken(e.target.value)}
                          placeholder="MyUltraSecureADBAccess2026"
                          className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-4 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                        />
                      </div>
                      <p className="text-[9px] text-gray-600 mt-1.5">
                        If provided, it will automatically append as <span className="font-mono text-gray-500">?token=VALUE</span> to the server connection URL.
                      </p>
                    </div>

                    <div className="border-t border-gray-800/60 pt-3">
                      <p className="text-[10px] text-gray-600 leading-normal">
                        Ensure your remote device is connected to a machine running the relay client agent pointing to this server.
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={handleConnectRemote}
                    disabled={!remoteUrl.trim()}
                    className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 text-white font-semibold rounded-xl shadow-lg shadow-emerald-900/20 hover:shadow-emerald-900/30 transition-all flex items-center space-x-2 text-sm"
                  >
                    <Wifi className="w-4 h-4" />
                    <span>Connect Remote Device</span>
                  </button>

                  <div className="w-full max-w-sm mt-6 pt-5 border-t border-gray-800/80">
                    <div className="flex items-start space-x-2.5 text-left">
                      <Globe className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                      <div>
                        <h4 className="text-[11px] font-bold text-gray-400">Zero Local Dependencies</h4>
                        <p className="text-[10px] text-gray-500 leading-normal">
                          The client receives the ADB packets, and Tango ADB handles standard security handshakes, server injection, and low-latency video decoding natively in your browser!
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Loading Progress Handshake Pipeline */}
        {connectionState.status !== 'idle' && connectionState.status !== 'active' && connectionState.status !== 'disconnected' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="max-w-md w-full mx-auto p-8 bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl text-center"
          >
            <div className="relative w-12 h-12 mx-auto mb-6 flex items-center justify-center">
              <div className="absolute inset-0 border-3 border-emerald-500/10 rounded-full" />
              <div className="absolute inset-0 border-3 border-t-emerald-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin" />
              <Cpu className="w-5 h-5 text-emerald-400" />
            </div>

            <h3 className="text-md font-bold text-gray-200 capitalize">
              {connectionState.status.replace('_', ' ')}
            </h3>
            
            {/* Timeline progress mapping */}
            <p className="text-xs text-gray-500 mt-2 min-h-[32px] px-4 leading-relaxed">
              {connectionState.status === 'connecting' && (
                connectionType === 'usb' 
                  ? "Requesting USB transport claiming. Please wait..." 
                  : "Establishing WebSocket connection to remote cloud relay..."
              )}
              {connectionState.status === 'authenticating' && "Awaiting cryptographic approval. LOOK AT YOUR PHONE screen and tap \"Allow USB debugging\"!"}
              {connectionState.status === 'connected' && "ADB security channel established successfully."}
              {connectionState.status === 'pushing_server' && "Uploading high-speed Scrcpy server binary to /data/local/tmp..."}
              {connectionState.status === 'starting_server' && "Spawning shell process daemon and opening reverse loop tunnels..."}
            </p>

            {/* Dynamic Step visualizer */}
            <div className="mt-6 flex justify-center items-center space-x-2">
              <div className={`w-2 h-2 rounded-full transition-colors ${['connecting', 'authenticating', 'connected', 'pushing_server', 'starting_server'].includes(connectionState.status) ? 'bg-emerald-500 shadow shadow-emerald-500/50' : 'bg-gray-800'}`} />
              <div className="w-4 h-0.5 bg-gray-800" />
              <div className={`w-2 h-2 rounded-full transition-colors ${['authenticating', 'connected', 'pushing_server', 'starting_server'].includes(connectionState.status) ? 'bg-emerald-500 shadow shadow-emerald-500/50' : 'bg-gray-800'}`} />
              <div className="w-4 h-0.5 bg-gray-800" />
              <div className={`w-2 h-2 rounded-full transition-colors ${['pushing_server', 'starting_server'].includes(connectionState.status) ? 'bg-emerald-500 shadow shadow-emerald-500/50' : 'bg-gray-800'}`} />
              <div className="w-4 h-0.5 bg-gray-800" />
              <div className={`w-2 h-2 rounded-full transition-colors ${['starting_server'].includes(connectionState.status) ? 'bg-emerald-500 shadow shadow-emerald-500/50' : 'bg-gray-800'}`} />
            </div>

            <button
              onClick={handleDisconnect}
              className="mt-8 px-4 py-2 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
            >
              Cancel Connection
            </button>
          </motion.div>
        )}

        {/* Active Stream Panel */}
        {connectionState.status === 'active' && scrcpyClient && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="w-full flex items-center justify-center"
          >
            <ScrcpyViewer 
              client={scrcpyClient} 
              onDisconnect={handleDisconnect} 
              deviceName={connectionState.deviceName}
              onOpenLauncher={handleOpenLauncher}
              initialTurnScreenOff={settings.turnScreenOff}
              initialAudioEnabled={settings.audio}
              initialMuteDeviceSpeaker={settings.muteDeviceSpeaker}
              adb={manager.getAdb()}
            />
          </motion.div>
        )}

        {/* Failure / Disconnection state panel */}
        {connectionState.status === 'disconnected' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="max-w-md w-full mx-auto p-8 bg-gray-900 border border-red-950/50 rounded-2xl shadow-2xl text-center"
          >
            <div className="w-12 h-12 bg-red-950/40 border border-red-500/20 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h3 className="text-md font-bold text-gray-200">Connection Terminated</h3>
            <p className="text-xs text-gray-400 mt-2 px-4 leading-relaxed bg-gray-950/40 border border-gray-800/80 p-3 rounded-xl font-mono text-left overflow-x-auto whitespace-pre-wrap">
              {connectionState.error || "An unknown ADB error occurred."}
            </p>
            
            {connectionState.error?.includes('claimInterface') && (
              <div className="mt-4 p-3 bg-blue-950/30 border border-blue-900/50 rounded-lg text-left">
                <h4 className="text-xs font-bold text-blue-400 mb-1">How to fix &quot;Unable to claim interface&quot;:</h4>
                <ul className="text-xs text-blue-200/80 list-disc pl-4 space-y-1">
                  <li>Another ADB server (like Android Studio or scrcpy desktop) is running. Open your terminal and run <code>adb kill-server</code>, then refresh this page.</li>
                  <li>You might need to unplug and re-plug your phone.</li>
                  <li>Ensure no other browser tabs are connected to the phone.</li>
                </ul>
              </div>
            )}
            
            {connectionState.error?.includes('ExactReadable ended') && (
              <div className="mt-4 p-3 bg-orange-950/30 border border-orange-900/50 rounded-lg text-left">
                <h4 className="text-xs font-bold text-orange-400 mb-1">Scrcpy Server Crashed:</h4>
                <ul className="text-xs text-orange-200/80 list-disc pl-4 space-y-1">
                  <li>Your device might not support the selected video encoder or resolution.</li>
                  <li>Try restarting your device or toggling USB Debugging off and on again.</li>
                </ul>
              </div>
            )}

            <div className="mt-6 flex flex-col space-y-2">
              <button
                onClick={handleRetryConnection}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl text-xs shadow-lg shadow-emerald-900/20 transition-all flex items-center justify-center space-x-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Connection</span>
              </button>
              <button
                onClick={handleDisconnect}
                className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold rounded-xl text-xs transition-colors"
              >
                Back to Dashboard
              </button>
            </div>
          </motion.div>
        )}
      </main>

      {/* App Launcher Modal */}
      {showAppLauncher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 backdrop-blur-sm p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h2 className="text-lg font-bold text-gray-100">App Launcher</h2>
              <button 
                onClick={() => setShowAppLauncher(false)}
                className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-4 border-b border-gray-800 bg-gray-950/50">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search packages..."
                  value={appSearchTerm}
                  onChange={(e) => setAppSearchTerm(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              {isLoadingApps ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <RefreshCw className="w-8 h-8 animate-spin mb-4" />
                  <p>Fetching installed apps...</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {installedApps
                    .filter(app => app.toLowerCase().includes(appSearchTerm.toLowerCase()))
                    .map(app => (
                      <button
                        key={app}
                        onClick={() => handleLaunchApp(app)}
                        className="flex items-center p-3 space-x-3 bg-gray-950/50 hover:bg-emerald-950/30 border border-gray-800 hover:border-emerald-900/50 rounded-xl text-left transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center group-hover:bg-emerald-900/50 transition-colors">
                          <Play className="w-4 h-4 text-emerald-400" />
                        </div>
                        <span className="flex-1 text-xs font-mono text-gray-300 truncate" title={app}>
                          {app}
                        </span>
                      </button>
                    ))}
                  {installedApps.filter(app => app.toLowerCase().includes(appSearchTerm.toLowerCase())).length === 0 && !isLoadingApps && (
                    <div className="col-span-full py-12 text-center text-gray-500">
                      No apps found matching &quot;{appSearchTerm}&quot;
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Humble Footer */}
      <footer className="border-t border-gray-900 py-6 text-center text-[10px] text-gray-600 font-mono">
        <p>Powered entirely by WebUSB & WebCodecs API • Zero Backend Dependencies</p>
      </footer>
    </div>
  );
}

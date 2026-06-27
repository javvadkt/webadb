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
  ExternalLink 
} from 'lucide-react';
import { AdbManager, ConnectionState } from './utils/adbManager';
import ScrcpyViewer from './components/ScrcpyViewer';
import { AdbScrcpyClient } from '@yume-chan/adb-scrcpy';
import { AdbWebUsbBackend } from '@yume-chan/adb-backend-webusb';

export default function App() {
  const [manager] = useState(() => new AdbManager());
  const [connectionState, setConnectionState] = useState<ConnectionState>({ status: 'idle' });
  const [pairedDevices, setPairedDevices] = useState<AdbWebUsbBackend[]>([]);
  const [scrcpyClient, setScrcpyClient] = useState<AdbScrcpyClient<any> | null>(null);

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
      });
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
    loadPairedDevices();
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
            </div>

            {/* Right column - Connection Panel */}
            <div className="md:col-span-2 flex flex-col justify-center items-center p-8 bg-gray-900/40 border border-gray-800/60 rounded-2xl text-center">
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
              {connectionState.status === 'connecting' && "Requesting USB transport claiming. Please wait..."}
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
            <p className="text-xs text-gray-400 mt-2 px-4 leading-relaxed bg-gray-950/40 border border-gray-800/80 p-3 rounded-xl font-mono text-left overflow-x-auto">
              {connectionState.error || "An unknown ADB error occurred."}
            </p>

            <div className="mt-6 flex flex-col space-y-2">
              <button
                onClick={handleRequestAndConnect}
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

      {/* Humble Footer */}
      <footer className="border-t border-gray-900 py-6 text-center text-[10px] text-gray-600 font-mono">
        <p>Powered entirely by WebUSB & WebCodecs API • Zero Backend Dependencies</p>
      </footer>
    </div>
  );
}

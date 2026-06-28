'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { 
  ArrowLeft, 
  Circle, 
  Square, 
  Power, 
  Volume1, 
  Volume2, 
  Activity, 
  Maximize2, 
  Minimize2,
  Tv,
  RotateCw,
  Grid,
  Smartphone
} from 'lucide-react';
import { AdbScrcpyClient } from '@yume-chan/adb-scrcpy';
import { h264ParseConfiguration, annexBSplitNalu } from '@yume-chan/scrcpy';

// Helper to convert H.264 Annex B format (start code separated) to AVCC format (4-byte length separated)
function annexBToAvcc(buffer: Uint8Array): Uint8Array {
  const nalus: Uint8Array[] = [];
  try {
    for (const nalu of annexBSplitNalu(buffer)) {
      nalus.push(nalu);
    }
  } catch (e) {
    // If splitting fails, return raw buffer as fallback
    console.error("Failed to split Annex B NAL units:", e);
    return buffer;
  }

  let totalLength = 0;
  for (const nalu of nalus) {
    totalLength += 4 + nalu.length;
  }

  const avcc = new Uint8Array(totalLength);
  let offset = 0;
  for (const nalu of nalus) {
    const len = nalu.length;
    avcc[offset++] = (len >> 24) & 0xFF;
    avcc[offset++] = (len >> 16) & 0xFF;
    avcc[offset++] = (len >> 8) & 0xFF;
    avcc[offset++] = len & 0xFF;
    avcc.set(nalu, offset);
    offset += len;
  }

  return avcc;
}

// Helper to format SPS & PPS into AVCDecoderConfigurationRecord (avcC) format for WebCodecs
function createAvcCDecoderConfigurationRecord(
  sps: Uint8Array,
  pps: Uint8Array,
  profileIndex: number,
  constraintSet: number,
  levelIndex: number
): Uint8Array {
  const totalLength = 1 + 1 + 1 + 1 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length;
  const avcC = new Uint8Array(totalLength);
  let offset = 0;

  avcC[offset++] = 1; // configurationVersion
  avcC[offset++] = profileIndex; // AVCProfileIndication
  avcC[offset++] = constraintSet; // profile_compatibility
  avcC[offset++] = levelIndex; // AVCLevelIndication
  avcC[offset++] = 0xFF; // lengthSizeMinusOne (reserved 6 bits + lengthSizeMinusOne 2 bits) -> 0xFF (4 bytes)
  avcC[offset++] = 0xE1; // numOfSequenceParameterSets (reserved 3 bits + numOfSPS 5 bits) -> 0xE1 (1 SPS)

  // SPS length (2 bytes, big endian)
  avcC[offset++] = (sps.length >> 8) & 0xFF;
  avcC[offset++] = sps.length & 0xFF;
  // SPS data
  avcC.set(sps, offset);
  offset += sps.length;

  avcC[offset++] = 1; // numOfPictureParameterSets

  // PPS length (2 bytes, big endian)
  avcC[offset++] = (pps.length >> 8) & 0xFF;
  avcC[offset++] = pps.length & 0xFF;
  // PPS data
  avcC.set(pps, offset);

  return avcC;
}

// Standard Android Motion Event Action Codes
enum AndroidMotionEventAction {
  Down = 0,
  Up = 1,
  Move = 2,
  Cancel = 3
}

interface ScrcpyViewerProps {
  client: AdbScrcpyClient<any>;
  onDisconnect: () => void;
  deviceName?: string;
  onOpenLauncher?: () => void;
  initialTurnScreenOff?: boolean;
}

export default function ScrcpyViewer({ client, onDisconnect, deviceName, onOpenLauncher, initialTurnScreenOff }: ScrcpyViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMouseDownRef = useRef<boolean>(false);

  const [resolution, setResolution] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [fps, setFps] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [scaleMode, setScaleMode] = useState<'fit' | 'stretch' | 'center'>('center');
  const [isScreenOff, setIsScreenOff] = useState<boolean>(false);
  const [viewRotation, setViewRotationState] = useState<0 | 90 | 180 | 270>(0);
  const viewRotationRef = useRef<0 | 90 | 180 | 270>(0);

  const [deviceRotation, setDeviceRotationState] = useState<0 | 1 | 2 | 3>(0);

  const setViewRotation = (rot: 0 | 90 | 180 | 270) => {
    viewRotationRef.current = rot;
    setViewRotationState(rot);
  };

  const handleDeviceRotate = () => {
    const next = ((deviceRotation + 1) % 4) as 0 | 1 | 2 | 3;
    setDeviceRotationState(next);
    if (client.controller?.rotateDevice) {
      client.controller.rotateDevice().catch(err => {
        console.error("Failed to rotate device:", err);
      });
    }
  };

  // Sync fullscreen state with document state
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isRealFs = !!document.fullscreenElement;
      if (!isRealFs && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [isFullscreen]);

  // Calculate FPS every second
  useEffect(() => {
    const interval = setInterval(() => {
      setFps(frameCount);
      setFrameCount(0);
    }, 1000);
    return () => clearInterval(interval);
  }, [frameCount]);

  // Apply initial screen power state from settings
  useEffect(() => {
    if (client && client.controller) {
      if (initialTurnScreenOff) {
        setIsScreenOff(true);
        // Add a slight delay to ensure controller is fully ready to process messages
        setTimeout(() => {
          client.controller?.setScreenPowerMode?.(0).catch((e) => {
             console.error("Failed to set initial screen power mode", e);
          });
        }, 500);
      }
    }
  }, [client, initialTurnScreenOff]);

  // Video stream consumer and decoder loop
  useEffect(() => {
    if (!client) return;
    let active = true;
    let decoder: VideoDecoder | null = null;
    let reader: any = null;

    async function startDecoding() {
      try {
        // Initialize WebCodecs VideoDecoder
        decoder = new VideoDecoder({
          output: (frame) => {
            if (!active) {
              frame.close();
              return;
            }
            const canvas = canvasRef.current;
            if (canvas) {
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const rot = viewRotationRef.current;
                const isRotated = rot === 90 || rot === 270;
                const targetWidth = isRotated ? frame.displayHeight : frame.displayWidth;
                const targetHeight = isRotated ? frame.displayWidth : frame.displayHeight;

                // Resize canvas buffer when device orientation/resolution/rotation changes
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                  canvas.width = targetWidth;
                  canvas.height = targetHeight;
                  setResolution({ width: targetWidth, height: targetHeight });
                }

                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.save();
                if (rot === 90) {
                  ctx.translate(canvas.width, 0);
                  ctx.rotate(Math.PI / 2);
                } else if (rot === 180) {
                  ctx.translate(canvas.width, canvas.height);
                  ctx.rotate(Math.PI);
                } else if (rot === 270) {
                  ctx.translate(0, canvas.height);
                  ctx.rotate(-Math.PI / 2);
                }
                ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
                ctx.restore();

                setFrameCount((prev) => prev + 1);
              }
            }
            frame.close();
          },
          error: (err) => {
            console.error("WebCodecs VideoDecoder internal error:", err);
            setError("Decoder error: " + err.message);
          }
        });

        // Get the Scrcpy video stream object
        const videoStream = await client.videoStream;
        if (!active) return;

        if (!videoStream || !videoStream.stream) {
          throw new Error("Scrcpy client returned an invalid video stream.");
        }

        reader = videoStream.stream.getReader();

        while (active) {
          const { value, done } = await reader.read();
          if (done || !active) break;

          // Handle incoming scrcpy packets
          if (value.type === 'configuration') {
            try {
              // Parse the Sequence Parameter Set (SPS) and Picture Parameter Set (PPS)
              const config = h264ParseConfiguration(value.data);
              
              // Generate standard AVCDecoderConfigurationRecord (avcC) bytes for WebCodecs
              const avcC = createAvcCDecoderConfigurationRecord(
                config.sequenceParameterSet,
                config.pictureParameterSet,
                config.profileIndex,
                config.constraintSet,
                config.levelIndex
              );

              // Dynamically build the H.264 codec string using profile and level indicators
              const profileHex = config.profileIndex.toString(16).padStart(2, '0');
              const constraintHex = config.constraintSet.toString(16).padStart(2, '0');
              const levelHex = config.levelIndex.toString(16).padStart(2, '0');
              const codecStr = `avc1.${profileHex}${constraintHex}${levelHex}`;

              console.log(`Configuring VideoDecoder with codec: ${codecStr}, size: ${config.croppedWidth}x${config.croppedHeight}`);
              
              setResolution({ width: config.croppedWidth, height: config.croppedHeight });

              decoder.configure({
                codec: codecStr,
                description: avcC,
                optimizeForLatency: true,
              });
            } catch (err: any) {
              console.error("Failed to parse/construct H264 avcC configuration, attempting raw fallback:", err);
              decoder.configure({
                codec: 'avc1.64002a', // standard compatible H.264 profile fallback
                description: value.data,
                optimizeForLatency: true,
              });
            }
          } else if (value.type === 'data') {
            if (decoder.state === 'configured') {
              try {
                const avccData = annexBToAvcc(value.data);
                const chunk = new EncodedVideoChunk({
                  type: value.keyframe ? 'key' : 'delta',
                  timestamp: value.pts !== undefined ? Number(value.pts) : 0,
                  data: avccData,
                });
                decoder.decode(chunk);
              } catch (decodeErr: any) {
                console.error("Failed to construct EncodedVideoChunk or decode:", decodeErr);
              }
            }
          }
        }
      } catch (err: any) {
        console.error("WebCodecs decoding loop error:", err);
        if (active) {
          setError("Stream closed: " + (err?.message || String(err)));
        }
      }
    }

    startDecoding();

    return () => {
      active = false;
      if (reader) {
        reader.cancel().catch(() => {});
      }
      if (decoder) {
        try {
          if (decoder.state !== 'closed') {
            decoder.close();
          }
        } catch (e) {
          console.error("Error cleaning up VideoDecoder:", e);
        }
      }
    };
  }, [client]);

  // Map pointer event coordinates and send to ADB control stream
  const sendTouchEvent = async (
    action: AndroidMotionEventAction,
    e: React.MouseEvent<HTMLCanvasElement>
  ) => {
    if (!client || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    // Layout relative coordinates
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    let scaleX = rect.width / canvas.width;
    let scaleY = rect.height / canvas.height;
    
    let offsetX = 0;
    let offsetY = 0;
    let drawWidth = rect.width;
    let drawHeight = rect.height;

    // Adjust for object-contain letterboxing
    if (scaleMode !== 'stretch') {
      const scale = Math.min(scaleX, scaleY);
      drawWidth = canvas.width * scale;
      drawHeight = canvas.height * scale;
      offsetX = (rect.width - drawWidth) / 2;
      offsetY = (rect.height - drawHeight) / 2;
      scaleX = scale;
      scaleY = scale;
    }

    const imageClientX = clientX - offsetX;
    const imageClientY = clientY - offsetY;

    // Ignore events that happen in the black letterbox borders
    if (
      imageClientX < 0 || 
      imageClientX > drawWidth || 
      imageClientY < 0 || 
      imageClientY > drawHeight
    ) {
      return;
    }

    // Map relative layout coords to intrinsic canvas coords
    const x = imageClientX / scaleX;
    const y = imageClientY / scaleY;

    // Calculate unrotated dimensions for original scrcpy coordinates
    const rot = viewRotationRef.current;
    const isRotated = rot === 90 || rot === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    // Translate coordinates back to unrotated space
    let pointerX = x;
    let pointerY = y;

    if (rot === 90) {
      pointerX = y;
      pointerY = origHeight - x;
    } else if (rot === 180) {
      pointerX = origWidth - x;
      pointerY = origHeight - y;
    } else if (rot === 270) {
      pointerX = origWidth - y;
      pointerY = x;
    }

    try {
      if (client.controller?.injectTouch) {
        await client.controller.injectTouch({
          action,
          pointerId: BigInt(0),
          pointerX,
          pointerY,
          videoWidth: origWidth,
          videoHeight: origHeight,
          pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
          actionButton: 0,
          buttons: action === AndroidMotionEventAction.Up ? 0 : 1,
        });
      }
    } catch (err) {
      console.error("Failed to inject pointer event:", err);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    isMouseDownRef.current = true;
    sendTouchEvent(AndroidMotionEventAction.Down, e);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    sendTouchEvent(AndroidMotionEventAction.Move, e);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    isMouseDownRef.current = false;
    sendTouchEvent(AndroidMotionEventAction.Up, e);
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    isMouseDownRef.current = false;
    sendTouchEvent(AndroidMotionEventAction.Cancel, e);
  };

  // Safe Android control injection wrappers
  const handleNavAction = async (actionType: 'back' | 'home' | 'appSwitch' | 'power' | 'volumeUp' | 'volumeDown') => {
    if (!client || !client.controller) return;
    try {
      const ctrl = client.controller as any;
      if (actionType === 'home') {
        if (typeof ctrl.home === 'function') await ctrl.home();
        else await injectKeyCodePair(3); // HOME keycode
      } else if (actionType === 'back') {
        if (typeof ctrl.back === 'function') await ctrl.back();
        else await injectKeyCodePair(4); // BACK keycode
      } else if (actionType === 'appSwitch') {
        if (typeof ctrl.appSwitch === 'function') await ctrl.appSwitch();
        else await injectKeyCodePair(187); // APP_SWITCH keycode
      } else if (actionType === 'power') {
        if (typeof ctrl.power === 'function') await ctrl.power();
        else await injectKeyCodePair(26); // POWER keycode
      } else if (actionType === 'volumeUp') {
        if (typeof ctrl.volumeUp === 'function') await ctrl.volumeUp();
        else await injectKeyCodePair(24); // VOLUME_UP keycode
      } else if (actionType === 'volumeDown') {
        if (typeof ctrl.volumeDown === 'function') await ctrl.volumeDown();
        else await injectKeyCodePair(25); // VOLUME_DOWN keycode
      }
    } catch (err) {
      console.error(`Failed navigation action ${actionType}:`, err);
    }
  };

  const injectKeyCodePair = async (keyCode: number) => {
    if (!client || !client.controller || !client.controller.injectKeyCode) return;
    try {
      await client.controller.injectKeyCode({
        action: 0, // Down
        keyCode: keyCode as any,
        repeat: 0,
        metaState: 0,
      });
      await client.controller.injectKeyCode({
        action: 1, // Up
        keyCode: keyCode as any,
        repeat: 0,
        metaState: 0,
      });
    } catch (e) {
      console.error("Failed to inject keycode pair:", e);
    }
  };

  // Fullscreen helper
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!isFullscreen) {
      setIsFullscreen(true);
      containerRef.current.requestFullscreen().catch(err => {
        console.warn("Natively entering fullscreen failed, falling back to simulated inline fullscreen:", err);
      });
    } else {
      setIsFullscreen(false);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => {
          console.warn("Failed to exit native fullscreen:", err);
        });
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-4xl mx-auto space-y-4">
      {/* Upper Status HUD */}
      <div className="flex flex-wrap items-center justify-between w-full px-4 py-2 text-xs bg-gray-900 border border-gray-800 rounded-lg text-gray-400">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-medium text-gray-200">{deviceName || "Android Device"}</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-1">
            <Tv className="w-3.5 h-3.5 text-gray-500" />
            <span>{resolution.width ? `${resolution.width}x${resolution.height}` : "Detecting..."}</span>
          </div>
          <div className="flex items-center space-x-1">
            <Activity className="w-3.5 h-3.5 text-gray-500" />
            <span className="font-mono text-emerald-400 font-semibold">{fps} FPS</span>
          </div>
        </div>
      </div>

      {/* Screen Canvas Container */}
      <div 
        ref={containerRef}
        className={`relative flex items-center justify-center bg-black transition-all duration-300 ${
          isFullscreen 
            ? 'fixed inset-0 z-50 w-screen h-screen rounded-none border-none' 
            : scaleMode === 'center'
              ? 'relative w-fit max-w-full mx-auto max-h-[70vh] rounded-xl overflow-hidden shadow-2xl border border-gray-800'
              : 'relative w-full h-[70vh] rounded-xl overflow-hidden shadow-2xl border border-gray-800'
        }`}
      >
        {error && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 bg-gray-950/90 text-center">
            <div className="p-3 mb-4 bg-red-900/30 border border-red-500/50 rounded-full text-red-400">
              <Power className="w-6 h-6 rotate-90" />
            </div>
            <h3 className="text-lg font-semibold text-gray-100">Stream Connection Error</h3>
            <p className="mt-2 text-sm text-gray-400 max-w-md">{error}</p>
            <button 
              onClick={onDisconnect}
              className="mt-6 px-4 py-2 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors"
            >
              Back to Dashboard
            </button>
          </div>
        )}

        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onContextMenu={async (e) => {
            e.preventDefault();
            if (!client || !client.controller) return;
            try {
              if (client.controller.backOrScreenOn) {
                await client.controller.backOrScreenOn(0); // Down
                await client.controller.backOrScreenOn(1); // Up
              } else {
                handleNavAction('back');
              }
            } catch (err) {
              console.error('Failed to send backOrScreenOn:', err);
            }
          }}
          className={`cursor-pointer transition-all duration-300 select-none ${
            scaleMode === 'center' 
              ? `w-auto h-auto max-w-full object-contain ${isFullscreen ? 'max-h-full' : 'max-h-[70vh]'}` 
              : scaleMode === 'fit' 
                ? 'w-full h-full object-contain' 
                : 'w-full h-full object-fill'
          }`}
          style={{ touchAction: 'none' }}
        />

         {/* Floating Quick Settings inside canvas area */}
        <div className="absolute top-3 right-3 flex space-x-2 opacity-30 hover:opacity-100 transition-opacity duration-200">
          <button 
            onClick={() => {
              const current = viewRotationRef.current;
              const next = ((current + 90) % 360) as 0 | 90 | 180 | 270;
              setViewRotation(next);
            }}
            className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-emerald-400 rounded-md transition-colors flex items-center space-x-1"
            title="Rotate View 90°"
          >
            <RotateCw className="w-4 h-4" />
            <span className="text-[10px] font-semibold px-0.5">{viewRotation}°</span>
          </button>
          <button 
            onClick={async () => {
              if (client.controller?.setScreenPowerMode) {
                try {
                  const newMode = isScreenOff ? 2 : 0; // 2 = Normal, 0 = Off
                  await client.controller.setScreenPowerMode(newMode);
                  setIsScreenOff(!isScreenOff);
                } catch (e) {
                  console.error('Failed to toggle screen power mode', e);
                }
              }
            }}
            className={`p-1.5 border rounded-md transition-colors ${isScreenOff ? 'bg-emerald-900/80 hover:bg-emerald-800 border-emerald-700/50 text-emerald-400' : 'bg-gray-900/80 hover:bg-gray-800 border-gray-700/50 text-gray-300'}`}
            title="Turn Phone Screen Off/On"
          >
            <Smartphone className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setScaleMode(prev => prev === 'center' ? 'fit' : prev === 'fit' ? 'stretch' : 'center')}
            className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-md transition-colors"
            title="Toggle Aspect Ratio"
          >
            {scaleMode === 'center' ? 'Center' : scaleMode === 'fit' ? 'Fit' : 'Stretch'}
          </button>
          <button 
            onClick={toggleFullscreen}
            className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-md transition-colors"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>

        {/* Floating Android System Control Bar for Fullscreen mode */}
        {isFullscreen && (
          <div className="absolute top-3 left-3 flex space-x-2 opacity-30 hover:opacity-100 transition-opacity duration-200">
            <button
              onClick={async () => {
                if (client.controller?.setScreenPowerMode) {
                  try {
                    const newMode = isScreenOff ? 2 : 0;
                    await client.controller.setScreenPowerMode(newMode);
                    setIsScreenOff(!isScreenOff);
                  } catch (e) {
                    console.error('Failed to toggle screen power mode', e);
                  }
                }
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors border flex items-center space-x-1.5 ${isScreenOff ? 'bg-emerald-950/80 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900' : 'bg-gray-900/80 text-gray-300 border-gray-700/50 hover:bg-gray-800'}`}
              title="Toggle Physical Device Screen (Keep Mirroring Alive)"
            >
              <Smartphone className="w-4 h-4" />
              <span className="hidden sm:inline">{isScreenOff ? "Screen Off" : "Screen On"}</span>
            </button>
            <div className="w-px h-6 bg-gray-700/50 self-center mx-1" />
            <button
              onClick={() => handleNavAction('power')}
              className="p-1.5 bg-gray-900/80 hover:bg-red-950/80 border border-gray-700/50 text-red-400 rounded-md transition-colors"
              title="Power Button"
            >
              <Power className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleNavAction('volumeDown')}
              className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-md transition-colors"
              title="Volume Down"
            >
              <Volume1 className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleNavAction('volumeUp')}
              className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-md transition-colors"
              title="Volume Up"
            >
              <Volume2 className="w-4 h-4" />
            </button>
            <div className="w-px h-6 bg-gray-700/50 self-center mx-1" />
            <button
              onClick={handleDeviceRotate}
              className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-blue-400 rounded-md transition-colors flex items-center"
              title="Rotate Device UI"
            >
              <RotateCw className="w-4 h-4" />
            </button>
            <div className="w-px h-6 bg-gray-700/50 self-center mx-1" />
            <button
              onClick={() => handleNavAction('back')}
              className="p-1.5 bg-gray-900/80 hover:bg-emerald-950/80 border border-gray-700/50 text-emerald-400 rounded-md transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleNavAction('home')}
              className="p-1.5 bg-gray-900/80 hover:bg-emerald-950/80 border border-gray-700/50 text-emerald-400 rounded-md transition-colors"
              title="Home"
            >
              <Circle className="w-4 h-4 fill-none" />
            </button>
            <button
              onClick={() => handleNavAction('appSwitch')}
              className="p-1.5 bg-gray-900/80 hover:bg-emerald-950/80 border border-gray-700/50 text-emerald-400 rounded-md transition-colors"
              title="Recents"
            >
              <Square className="w-4 h-4 fill-none" />
            </button>
            <div className="w-px h-6 bg-gray-700/50 self-center mx-1" />
            <button
              onClick={onDisconnect}
              className="px-2 py-1.5 text-[10px] font-semibold bg-rose-900/80 hover:bg-rose-800/80 border border-rose-700/50 text-rose-200 rounded-md transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Primary Android Navigation & Quick Controller Bar */}
      <div className="flex items-center justify-between w-full px-6 py-3 bg-gray-900 border border-gray-800 rounded-xl shadow-lg">
        {/* Left Actions - Power/Volume/Rotation */}
        <div className="flex items-center space-x-2">
          <button
            onClick={async () => {
              if (client.controller?.setScreenPowerMode) {
                try {
                  const newMode = isScreenOff ? 2 : 0;
                  await client.controller.setScreenPowerMode(newMode);
                  setIsScreenOff(!isScreenOff);
                } catch (e) {
                  console.error('Failed to toggle screen power mode', e);
                }
              }
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border flex items-center space-x-1.5 ${isScreenOff ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60' : 'bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800 hover:text-gray-200'}`}
            title="Toggle Physical Device Screen (Keep Mirroring Alive)"
          >
            <Smartphone className="w-4 h-4" />
            <span className="hidden sm:inline">{isScreenOff ? "Screen Off" : "Screen On"}</span>
          </button>
          <div className="w-px h-6 bg-gray-800 mx-1" />
          <button
            onClick={() => handleNavAction('power')}
            className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors border border-transparent hover:border-red-900/30"
            title="Power Button"
          >
            <Power className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleNavAction('volumeDown')}
            className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
            title="Volume Down"
          >
            <Volume1 className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleNavAction('volumeUp')}
            className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
            title="Volume Up"
          >
            <Volume2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleDeviceRotate}
            className="p-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/20 rounded-lg transition-colors flex items-center space-x-1 border border-transparent hover:border-emerald-900/30"
            title="Rotate Device OS"
          >
            <RotateCw className="w-4 h-4" />
          </button>
          <div className="w-px h-6 bg-gray-800 mx-2" />
          <button
            onClick={onOpenLauncher}
            className="p-2 text-emerald-400 bg-emerald-950/20 hover:bg-emerald-900/40 rounded-lg transition-colors flex items-center space-x-1 border border-emerald-900/30"
            title="App Launcher"
          >
            <Grid className="w-4 h-4" />
          </button>
        </div>

        {/* Center Navigation - Android System Bar */}
        <div className="flex items-center space-x-6">
          <button
            onClick={() => handleNavAction('back')}
            className="px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
            title="Back Button"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => handleNavAction('home')}
            className="px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
            title="Home Button"
          >
            <Circle className="w-5 h-5 fill-none" />
          </button>
          <button
            onClick={() => handleNavAction('appSwitch')}
            className="px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
            title="Recents Button"
          >
            <Square className="w-4 h-4 fill-none" />
          </button>
        </div>

        {/* Right Action - Disconnect */}
        <div>
          <button
            onClick={onDisconnect}
            className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg shadow transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
